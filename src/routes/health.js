'use strict';

const express = require('express');
const { pool } = require('../db/pool');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'ok', db: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'degraded', db: 'unreachable' });
  }
});

module.exports = router;
