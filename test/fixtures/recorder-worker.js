'use strict';

const fs = require('node:fs');

process.on('exit', () => fs.writeFileSync(process.env.TEST_STOPPED, 'stopped'));
require('../../bin/native-recorder');
