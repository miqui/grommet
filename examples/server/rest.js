// (C) Copyright 2014-2015 Hewlett-Packard Development Company, L.P.

var _ = require('lodash');
var express = require('express');
var router = express.Router();
var ws = require("ws");
var stringify = require("json-stringify-pretty-compact");
var data = require('./data');
var generator = require('./generator');
var filter = require('./filter');
var map = require('./map');

// remove following requires when request access is removed
var nodemailer = require('nodemailer');
var path = require('path');
var templatesDir = path.resolve(__dirname, 'templates');
var emailTemplates = require('email-templates');
var nodemailer = require('nodemailer');
var smtpTransport = require('nodemailer-smtp-transport');
var fs = require("fs");

// Actions

function filteredItems (items, queryParams) {
  if (queryParams.userQuery) {
    items = filter.filterUserQuery(items, queryParams.userQuery);
  }
  if (queryParams.query) {
    items = filter.filterQuery(items, queryParams.query);
  }
  return items;
}

function getItems (url, queryParams) {
  var items = data.getItems(queryParams.category);
  var unfilteredTotal = items.length;
  items = filteredItems(items, queryParams);

  if (queryParams.sort) {
    filter.sort(items, queryParams.sort);
  }

  var startIndex = +queryParams.start; // coerce to be a number
  if (queryParams.referenceUri) {
    items.some(function(item, index) {
      if (queryParams.referenceUri === item.uri) {
        startIndex = Math.max(index - 3, 0);
        return true;
      }
    });
  }

  // prune for start+count
  var total = items.length;
  items = items.slice(startIndex, startIndex + queryParams.count);

  return {
    category: queryParams.category,
    start: startIndex,
    count: items.length,
    total: total,
    unfilteredTotal: unfilteredTotal,
    items: items
  };
}

function getAggregate (url, queryParams) {
  var items = data.getItems(queryParams.category) || [];
  items = filteredItems(items, queryParams);

  var attributes;
  if (Array.isArray(queryParams.attribute)) {
    attributes = queryParams.attribute;
  } else {
    attributes = [queryParams.attribute];
  }
  var result = attributes.map(function(attribute) {
    return {
      attribute: attribute,
      counts: []
    };
  });

  var intervals = null;
  if (queryParams.interval) {
    intervals = [];
    var stop =  new Date();
    stop.setHours(23,59,59,999);
    for (var i=0; i<queryParams.count; i++) {
      var start = new Date(stop.getTime() + 1);
      start.setDate(start.getDate() - 1);
      intervals.push({start: start.toISOString(), stop: stop.toISOString()});
      stop = new Date(start.getTime() - 1);
    }
  }

  items.some(function(resource) {
    result.forEach(function(attributeResult) {

      var value;
      if (resource.hasOwnProperty(attributeResult.attribute)) {
        value = resource[attributeResult.attribute];
      } else if (resource.attributes &&
        resource.attributes.hasOwnProperty(attributeResult.attribute)) {
        value = resource.attributes[attributeResult.attribute];
      }

      if (undefined !== value) {
        var counts = attributeResult.counts;
        var count = null;
        for (var i = 0; i < counts.length; i++) {
          if (value === counts[i].value) {
            count = counts[i];
            break;
          }
        }

        if (!count) {
          var count = {value: value, count: 0};
          if (intervals) {
            count.intervals = _.map(intervals, _.clone);
          }
          counts.push(count);
        }
        count.count += 1;

        if (count.intervals) {
          for (i=0; i<count.intervals.length; i++) {
            var interval = count.intervals[i];
            if (! interval.count) {
              interval.count = 0;
            }
            if (resource.created >= interval.start &&
              resource.created <= interval.stop) {
              interval.count += 1;
            }
          }
        }
      }
    });
  });

  return result;
}

// WebSocket interaction

var socketServer;
var connections = [];

function closeConnection (connection) {
  if (connection.ws) {
    connection.ws.close();
    connection.ws = null;
    var index = connections.indexOf(connection);
    connections.splice(index, 1);
  }
}

var MAP_REGEXP = /^\/rest\/index\/trees\/aggregated(.+)$/;

function respondToRequest (connection, request) {
  var response = {op: 'update', id: request.id};

  if ('/rest/index/resources' === request.url) {
    response.result = getItems(request.url, request.params);
  } else if ('/rest/index/resources/aggregated' === request.url) {
    response.result = getAggregate(request.url, request.params);
  } else if (MAP_REGEXP.test(request.url)) {
    var uri = MAP_REGEXP.exec(request.url)[1];
    response.result = map.build(uri);
  } else {
    var resource = data.getResource(request.url);
    if (resource) {
      response.result = resource;
    } else {
      response.op = 'error';
      response.result = 'unknown url ' + request.url;
    }
  }

  if (connection.ws) {
    var serializedResponse = JSON.stringify(response);
    console.log(response.op.toUpperCase(), request.url,
      stringify(request.params), serializedResponse.length);
    connection.ws.send(serializedResponse);
  }

  if ('error' === response.op) {
    closeConnection(connection);
  }
}

function onMessage (connection, request) {
  if ('start' === request.op) {
    console.log('WATCH', request.url, stringify(request.params));
    connection.requests.push(request);
    respondToRequest(connection, request);
  } else if ('stop' === request.op) {
    // Remove request
    connection.requests = connection.requests.filter(function (req) {
      return (req.id !== request.id);
    });
  } else {
    if (connection.ws) {
      connection.ws.send({error: 'unknown op ' + request.op});
      closeConnection(connection);
    }
  }
}

function onConnection (ws) {
  var connection = {
    ws: ws,
    requests: []
  };
  connections.push(connection);

  ws.on('message', function incoming(message) {
    onMessage(connection, JSON.parse(message));
  });

  ws.on("close", function () {
    closeConnection(connection);
  });
}

function initializeSocket (server) {
  socketServer = new ws.Server({server: server, path: "/rest/ws"});
  socketServer.on("connection", onConnection);
}

function requestMatches (request, events) {
  // If the request category(ies) or the request url match the change, respond
  var category;
  var uri;
  if (request.params && request.params.category) {
    category = request.params.category;
  } else {
    uri = request.url;
  }
  return events.some(function (event) {
    if (category) {
      return (category === event.category ||
        (Array.isArray(category) &&
        category.indexOf(event.category) !== -1));
    } else {
      return (uri === event.uri);
    }
  });
}

function onResourceChange (events) {
  connections.forEach(function (connection) {
    connection.requests.forEach(function (request) {
      if (requestMatches(request, events)) {
        respondToRequest(connection, request);
      }
    });
  });
}

// REST interaction

router.post('/login-sessions', function(req, res) {
  if ('error' === req.body.userName) {
    res.status(400).send({
      message: "Invalid username or password or directory.",
      resolution: "Enter correct credentials and try again." +
        " To obtain a username or password, contact your security administrator."
    });
  } else {
    res.json({
      sessionID: 'abc123'
    });
  }
});

router.delete('/login-sessions', function(req, res) {
  res.json(null);
});

router.get('/preferences/index', function(req, res) {
  var preferences = data.getPreferences(req.headers.auth, req.query.category);
  if (! preferences) {
    res.status(404).send();
  } else {
    res.json(preferences);
  }
});

// Email for Request Access TODO: move to a separate module?
function handleEmailResponse(error, info) {
  if (error) {
    console.log(error);
  } else {
    console.log('Message sent: ' + info.response);
  }
}

router.post('/request-access', function(req, res) {

  var data = req.body;

  if (!data.name || !data.email || !data.businessPurpose || !data.github) {
    res.status(400).send({
      message: "Invalid payload.",
      recommendedActions: "Enter name, email, and businessPurpose and try again."
    });
  }

  var requestsFilePath = path.resolve(__dirname, 'requests.csv');

  fs.exists(requestsFilePath, function(exists) {

    var contentCsv = [data.name, data.email, data.businessPurpose, data.github]
      .join() + '\n';

    if (exists) {
      fs.appendFile(requestsFilePath, contentCsv, function(err) {
        if (err) {
          console.log('Error while creating the requests.csv: ' + err);
        } else {
          console.log(requestsFilePath + ' has been successfully created!');
        }
      });
    } else {
      fs.writeFile(requestsFilePath, contentCsv, function(err) {
        if (err) {
          console.log('Error while updating the requests.csv: ' + err);
        } else {
          console.log(requestsFilePath + ' has been successfully updated!');
        }
      });

    }

  });

  var transport = nodemailer.createTransport(smtpTransport({
    host: 'localhost',
    port: 25
  }));

  var toGrommetConfig = {
    from: data.email,
    to: 'uxgroup@hp.com',
    subject: 'Evaluate access for ' + data.email,
    text: data.name + ' with this email: ' + data.email +
      ' wants to access Grommet for this reason: ' + data.businessPurpose +
      '. The Github account is: ' + data.github + '.'
  };

  emailTemplates(templatesDir, function(err, template) {
    if (err) {
      console.log(err);
    } else {
      template('welcome', data, function(err, html, text) {
        if (err) {
          console.log(err);
        } else {
          var toRequesterConfig = {
            from: 'grommet@hp.com',
            to: data.email,
            subject: 'Welcome to Grommet!',
            text: text,
            html: html
          };

          transport.sendMail(toRequesterConfig, handleEmailResponse);
        }
      });
    }
  });

  transport.sendMail(toGrommetConfig, handleEmailResponse);

  res.sendStatus(200);
});

router.get('/index/resources', function(req, res) {
  var result = getItems('/rest' + req.url, req.query);
  res.json(result);
});

router.get('/index/resources/aggregated', function(req, res) {
  var result = getAggregate('/rest' + req.url, req.query);
  res.json(result);
});

router.get(/^\/index\/search-suggestions/, function(req, res) {
  var items = data.getItems(req.query.category || null);

  if (req.query.userQuery) {
    items = filter.filterUserQuery(items, req.query.userQuery);
  }

  if (req.query.query) {
    items = filter.filterQuery(items, req.query.query);
  }

  var startIndex = +req.query.start; // coerce to be a number
  // prune for start+count
  items = items.slice(startIndex, startIndex + req.query.count);

  res.json(items.map(function(item) {
    return {
      name: item.name,
      category: item.category,
      uri: item.uri
    }
  }));
});

router.get(/^\/index\/trees\/aggregated(.+)$/, function(req, res) {
  var uri = req.params[0];
  res.json(map.build(uri));
});

router.get(/^\/index\/trees(.+)$/, function(req, res) {
  var uri = req.params[0];
  res.status(501).send();
});

router.get('/:categoryName/*', function(req, res) {
  var resource = data.getResource('/rest' + req.url);
  if (resource) {
    res.json(resource);
  } else {
    res.status(404).send();
  }
});

function createTask (categoryName, action, resource) {
  var now = new Date();

  var task = {
    category: 'tasks',
    uri: '/rest/tasks/' + now.getTime(),
    name: action,
    status: 'Unknown',
    state: 'Running',
    attributes: {
      associatedResourceUri: resource.uri,
      associatedResourceName: resource.name,
      associatedResourceCategory: categoryName,
      hidden: false
    },
    created: now.toISOString(),
    modified: now.toISOString()
  };
  data.addResource('tasks', task);

  return task;
}

router.post('/:categoryName', function(req, res) {
  var categoryName = req.params.categoryName;
  var now = new Date();

  var resource = _.extend({
    category: categoryName,
    uri: '/rest/' + categoryName + '/' + now.getTime(),
    status: 'Unknown',
    state: 'Normal',
    created: now.toISOString(),
    modified: now.toISOString()
  }, req.body);
  data.addResource(categoryName, resource);

  var task = createTask(categoryName, 'Add', resource);

  res.json({
    taskUri: task.uri
  });

  setTimeout(function() {
    resource.status = 'OK',
    task.status = 'OK';
    task.state = 'Completed';
    task.modified = (new Date()).toISOString();
    onResourceChange([
      {category: resource.category, uri: resource.uri},
      {category: task.category, uri: task.uri},
    ]);
  }, 10000);

  setTimeout(function () {
    onResourceChange([
      {category: resource.category, uri: resource.uri},
      {category: task.category, uri: task.uri},
    ]);
  }, 1);
});

router.put('/:categoryName/*', function(req, res) {
  var categoryName = req.params.categoryName;
  var resource = req.body;
  var now = new Date();
  resource.modified = now.toISOString();
  data.updateResource(categoryName, resource);

  var task = createTask(categoryName, 'Update', resource);

  res.json({
    taskUri: task.uri
  });

  setTimeout(function() {
    task.status = 'OK';
    task.state = 'Completed';
    task.modified = (new Date()).toISOString();
    onResourceChange([{category: task.category, uri: task.uri}]);
  }, 10000);

  setTimeout(function () {
    onResourceChange([
      {category: resource.category, uri: resource.uri},
      {category: task.category, uri: task.uri},
    ]);
  }, 1);
});

router.delete('/:categoryName/*', function(req, res) {
  var categoryName = req.params.categoryName;
  var resource = data.getResource('/rest' + req.url);

  var task = createTask(categoryName, 'Delete', resource);

  res.json({
    taskUri: task.uri
  });

  setTimeout(function() {
    data.deleteResource(categoryName, '/rest' + req.url);
    task.status = 'OK';
    task.state = 'Completed';
    task.modified = (new Date()).toISOString();
    onResourceChange([
      {category: resource.category, uri: resource.uri},
      {category: task.category, uri: task.uri},
    ]);
  }, 10000);

  setTimeout(function () {
    onResourceChange([{category: task.category, uri: task.uri}]);
  }, 1);
});

module.exports = {
  router: router,
  setup: function (server) {
    generator.generate();
    initializeSocket(server);
    generator.listen(onResourceChange);
  }
};
