const PORT = 3000;
const HOST = '0.0.0.0';

const express = require('express')
const morgan = require('morgan');
const fs = require('fs');
const path = require('path');

const logFile = fs.createWriteStream('./access.log', { flags: 'a' });

const app = express()

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.text());

morgan.token('body', req => {
  return req.body
})

morgan.token('headers', function (req, res) {
  return req.headers
})

app.use(morgan(function (tokens, req, res) {
  return JSON.stringify({
    date: tokens.date(req, res),
    ip: tokens['remote-addr'](req, res),
    method: tokens.method(req, res),
    url: tokens.url(req, res),
    status: tokens.status(req, res),
    headers: tokens.headers(req, res),
    request: tokens.body(req, res),
  });
}, {
  stream: logFile,
  skip: function (req, res) { return req.url != '/aws' }
}));

app.all('/aws', (req, res) => {
  try {
    const fwEndpoints = process.env.FW_ENDPOINTS.split(',')
    const fwEndpointTokens = process.env.FW_ENDPOINT_TOKENS.split(',')

    fwEndpoints.forEach(async (endpoint, i) => {
      const token = fwEndpointTokens[i]

      await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: token },
        body: JSON.stringify(minimizeData(req.body, true))
      });
    });
  } catch (error) { console.log(error) }

  res.json(req.body);
})

app.get('/access', (req, res) => {
  if (req.headers.Authorization !== process.env.ACCESS_TOKEN) res.statusCode = 401, res.send('Unauthorized');

  fs.createReadStream("./access.log").pipe(res);
})

app.get('/chart', (req, res) => {
  res.sendFile(path.join(__dirname + "/chart.html"));
})

const parseJSON = (str, def = false) => {
  try {
    return JSON.parse(str);
  } catch (e) {
    return def === false ? str : def;
  }
}

const minimizeData = (request, withEmail = false) => {
  let snsMessage = request?.Message
  request.Message = parseJSON(snsMessage)

  if (!request?.Message?.bounce) return null;

  snsMessage = request.Message;
  const bounce = snsMessage?.bounce;

  let minimizedData = {
    bounceType: bounce?.bounceType,
    bounceSubType: bounce?.bounceSubType,
    mail: {
      timestamp: snsMessage?.mail?.timestamp,
      source: snsMessage?.mail?.source,
      sourceIp: snsMessage?.mail?.sourceIp,
      topic: snsMessage?.mail?.headers?.filter((h) => h.name === 'X-Mail-Topic').pop()?.value,
    }
  }

  if (withEmail) {
    minimizedData['bouncedRecipients'] = bounce?.bouncedRecipients
  }

  return minimizedData
}

app.get('/data', (req, res) => {
  const data = fs.readFileSync("./access.log", "utf-8");
  const lines = data.split('\n');

  jsonData = []
  lines.forEach(line => {
    let json = parseJSON(line, null)
    if (!json) return

    json.request = parseJSON(json.request)

    const minimizedData = minimizeData(json.request, false)

    if (minimizedData) jsonData.push(minimizedData)
  });

  res.json(jsonData);
})

app.listen(PORT, HOST)
