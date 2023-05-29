const PORT = 3000;
const HOST = '0.0.0.0';

const express = require('express')
const path = require('path');
const sqlite3 = require('sqlite3');

const db = new sqlite3.Database('./db/sns.db');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS sns (
    id INTEGER PRIMARY KEY,
    date DATE_TIME DEFAULT CURRENT_TIMESTAMP,
    ip TEXT,
    method TEXT,
    message_type TEXT,
    token_alias TEXT,
    headers LONGTEXT,
    request LONGTEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS bounced_emails (
    email TEXT PRIMARY KEY,
    date DATE_TIME DEFAULT CURRENT_TIMESTAMP,
    last_request INTEGER,

    FOREIGN KEY (last_request) REFERENCES sns(id) ON UPDATE CASCADE ON DELETE SET NULL
  )`);
});

const app = express()

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.text());

const verifyToken = (token) => {
  if (!process.env.ACCESS_TOKENS) return 'no-token';

  const tokens = process.env.ACCESS_TOKENS.split(',')
  const aliases = process.env.ACCESS_TOKENS_ALIASES ? process.env.ACCESS_TOKENS_ALIASES.split(',') : null

  if (tokens.length <= 0) return 'no-token'

  const i = tokens.findIndex((t) => t == token)

  if (!aliases && i >= 0) return i

  try {
    return aliases[i]
  } catch (e) { }

  return null;
}

app.all('/aws/:auth', (req, res) => {
  const tokenAlias = verifyToken(req.params.auth);
  if (!tokenAlias) {
    res.statusCode = 401;
    return res.send('Unauthorized')
  }

  let body = parseJSON(req.body)
  if (body?.Type) {
    messageType = body?.Type
    body.Message = parseJSON(body?.Message);

    db.serialize(async () => {
      db.run("INSERT INTO sns (ip, method, message_type, token_alias, headers, request) VALUES (?, ?, ?, ?, ?, ?)", [req.ip, req.method, messageType, tokenAlias, JSON.stringify(req.headers), JSON.stringify(body)]);

      if (body?.Message?.bounce?.bouncedRecipients) {
        db.get('SELECT last_insert_rowid() as id', (e, last) => {
          if (e) return;

          const stmt = db.prepare("INSERT OR REPLACE INTO bounced_emails (email, last_request) VALUES (?, ?)");
          body.Message.bounce.bouncedRecipients.forEach((be) => {
            stmt.run([be.emailAddress, last.id])
          });
        })
      }
    });
  }

  try {
    const fwEndpoints = process.env.FW_ENDPOINTS ? process.env.FW_ENDPOINTS.split(',') : []
    const fwEndpointTokens = process.env.FW_ENDPOINT_TOKENS ? process.env.FW_ENDPOINT_TOKENS.split(',') : []

    fwEndpoints.forEach(async (endpoint, i) => {
      let token;
      try {
        token = fwEndpointTokens[i]
      } catch (e) { }

      await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: token, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(minimizeData(body, true))
      });
    });
  } catch (error) { console.log(error) }

  res.json(body);
})

app.get('/subscription-confirmations', (req, res) => {
  if (!verifyToken(req.headers.authorization)) {
    res.statusCode = 401
    return res.send('Unauthorized');
  }

  db.serialize(async () => {
    db.all("SELECT * FROM sns WHERE message_type = 'SubscriptionConfirmation'", (_, c) => {
      c.forEach((r) => {
        r.headers = parseJSON(r?.headers)
        r.request = parseJSON(r?.request)
      })

      res.json(c);
    })
  });
})

app.get('/sns-data', (req, res) => {
  let withEmail = false;
  if (verifyToken(req.headers.authorization)) {
    withEmail = true;
  }

  db.serialize(async () => {
    db.all("SELECT * FROM sns WHERE message_type = 'Notification'", (_, c) => {
      c.forEach((r) => {
        r.minimizedData = minimizeData(parseJSON(r?.request), withEmail)
      })

      res.json(c.map((e) => e.minimizedData));
    })
  });
})

app.get('/sns-analysis', (_, res) => {
  res.sendFile(path.join(__dirname + "/src/chart.html"));
})

app.get('/check', (req, res) => {
  if (!verifyToken(req.headers.authorization)) {
    res.statusCode = 401
    return res.send('Unauthorized');
  }

  db.serialize(async () => {
    db.get("SELECT bounced_emails.*, sns.request FROM bounced_emails LEFT JOIN sns ON sns.id = bounced_emails.last_request WHERE LOWER(email) = LOWER(?)", [req.query.email], (e, r) => {
      if (e) return res.json({ success: false, error: true, message: e.message })

      if (!r) return res.json({ success: true, error: false })

      return res.json({ success: false, error: false, message: parseJSON(r?.request) })
    })
  });
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

app.listen(PORT, HOST)
