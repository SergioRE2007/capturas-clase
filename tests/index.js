'use strict';
// Permite `node --test tests/` (Node ≥ 22 trata la carpeta como un módulo): carga todos los *.test.js.
const fs = require('node:fs');
const path = require('node:path');
for (const f of fs.readdirSync(__dirname).filter((n) => n.endsWith('.test.js')).sort()) require(path.join(__dirname, f));
