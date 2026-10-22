const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
const mysql = require('mysql2/promise');
// It will use environment variables in the cloud, or fallback locally if needed
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'your_local_password',
  database: process.env.DB_NAME || 'pwd_inventory_db',
  ssl: process.env.DB_HOST ? { rejectUnauthorized: false } : null // Required for cloud providers like Aiven
});

pool.getConnection()
  .then(connection => {
    console.log('Successfully connected to the MySQL database!');
    connection.release();
  })
  .catch(err => {
    console.error('Database connection failed:', err.message);
  });

// ==========================================
// 1. USER AUTHENTICATION & MANAGEMENT ROUTES
// ==========================================

// Get list of all users (for dropdown selections & admin password resets)
app.get('/api/users', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT user_key, name, role, subdiv FROM users');
    res.json(rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// Login authentication route
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const [rows] = await pool.query('SELECT * FROM users WHERE user_key = ?', [username.toLowerCase().trim()]);

    if (rows.length === 0 || rows[0].password !== password) {
      return res.status(401).json({ message: 'Invalid User ID or Password' });
    }

    const user = rows[0];
    res.json({
      ...user,
      buildings: user.buildings ? JSON.parse(user.buildings) : []
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// Change Password (Self-Service)
app.patch('/api/users/:key/password', async (req, res) => {
  try {
    const { key } = req.params;
    const { oldPassword, newPassword } = req.body;

    const [rows] = await pool.query('SELECT * FROM users WHERE user_key = ?', [key]);
    if (rows.length === 0) return res.status(404).json({ message: 'User not found' });

    if (rows[0].password !== oldPassword) {
      return res.status(400).json({ message: 'Incorrect current password' });
    }

    await pool.query('UPDATE users SET password = ? WHERE user_key = ?', [newPassword, key]);
    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// Add a reset_requested column to users table if not already present, or handle it via a memory/status table.
// For simplicity with our existing schema, we can add a quick tracking table or handle requests via a lightweight endpoint:

// 1. SAE/SDE Request Password Reset -> ONLY sets flag reset_requested = 1 (Password is UNCHANGED)
app.post('/api/users/request-reset', async (req, res) => {
  try {
    const { targetUserKey } = req.body;

    // Check if user exists
    const [users] = await pool.query('SELECT * FROM users WHERE user_key = ?', [targetUserKey]);
    if (users.length === 0) {
      return res.status(404).json({ message: 'User ID not found in system.' });
    }

    // Set flag ONLY (do NOT change password here)
    await pool.query('UPDATE users SET reset_requested = 1 WHERE user_key = ?', [targetUserKey]);

    res.json({ message: `Password reset request for ${targetUserKey} successfully submitted to the Executive Engineer.` });
  } catch (err) {
    console.error('Request reset error:', err);
    res.status(500).json({ message: 'Server error while sending request.' });
  }
});

// 2. EE Fetch Pending Requests
app.get('/api/admin/reset-requests', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT user_key, name, role, subdiv FROM users WHERE reset_requested = 1');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error fetching requests.' });
  }
});

// 3. EE Manual Approval -> THIS is the only place where password changes to '123456'
app.post('/api/admin/execute-reset', async (req, res) => {
  try {
    const { targetUserKey, adminKey } = req.body;

    // Verify EE authorization
    const [adminRows] = await pool.query('SELECT role FROM users WHERE user_key = ?', [adminKey]);
    if (adminRows.length === 0 || adminRows[0].role !== 'EE') {
      return res.status(403).json({ message: 'Unauthorized: Only Executive Engineer (EE) can approve password resets.' });
    }

    // Update password to 123456 and clear reset_requested flag
    await pool.query('UPDATE users SET password = ?, reset_requested = 0 WHERE user_key = ?', ['123456', targetUserKey]);

    res.json({ message: `Password for ${targetUserKey} has been reset to 123456 by EE.` });
  } catch (err) {
    console.error('Execute reset error:', err);
    res.status(500).json({ message: 'Server error during password reset.' });
  }
});
// ==========================================
// 2. INVENTORY RECORDS & WORKFLOW ROUTES
// ==========================================

// Get all inventory records with filters
app.get('/api/records', async (req, res) => {
  try {
    const { subdiv, saeKey, status } = req.query;
    let query = 'SELECT * FROM inventory_records WHERE 1=1';
    let values = [];

    if (subdiv && subdiv !== 'ALL') {
      query += ' AND subdiv = ?';
      values.push(subdiv);
    }
    if (saeKey && saeKey !== 'ALL') {
      query += ' AND sae_key = ?';
      values.push(saeKey);
    }
    if (status && status !== 'ALL') {
      query += ' AND status = ?';
      values.push(status);
    }

    query += ' ORDER BY date DESC, id DESC';
    
    const [rows] = await pool.query(query, values);
    
    const formattedRows = rows.map(row => ({
      ...row,
      fittings: typeof row.fittings === 'string' ? JSON.parse(row.fittings) : row.fittings
    }));

    res.json(formattedRows);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// Submit a new inventory record
app.post('/api/records', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const { id, date, inspectionTime, subdiv, saeKey, saeName, buildingJurisdiction, buildingName, building, room, fittings, notes, photo } = req.body;
    
    const insertQuery = `
      INSERT INTO inventory_records (id, date, inspection_time, subdiv, sae_key, sae_name, building_jurisdiction, building_name, building, room, fittings, notes, photo, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')
    `;
    
    const values = [
      id, date, inspectionTime || '10:00 AM', subdiv, saeKey, saeName, 
      buildingJurisdiction, buildingName, building, room, 
      JSON.stringify(fittings), notes, photo
    ];
    
    await connection.query(insertQuery, values);

    await connection.query(
      'INSERT INTO record_history (record_id, action, performed_by) VALUES (?, ?, ?)',
      [id, 'SUBMITTED', saeKey]
    );

    await connection.commit();
    res.status(201).json({ message: 'Record created successfully', id });
  } catch (err) {
    await connection.rollback();
    console.error(err.message);
    res.status(500).send('Server Error');
  } finally {
    connection.release();
  }
});

// Update Status (SDE Verify / EE Accept / Returns)
app.patch('/api/records/:id/status', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const { id } = req.params;
    const { status, reason, userKey } = req.body;

    await connection.query(
      'UPDATE inventory_records SET status = ? WHERE id = ?',
      [status, id]
    );

    await connection.query(
      'INSERT INTO record_history (record_id, action, performed_by, reason) VALUES (?, ?, ?, ?)',
      [id, status, userKey, reason || null]
    );

    await connection.commit();
    res.json({ message: 'Status updated successfully' });
  } catch (err) {
    await connection.rollback();
    console.error(err.message);
    res.status(500).send('Server Error');
  } finally {
    connection.release();
  }
});

// SDE Edit Record
app.put('/api/records/:id', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const { id } = req.params;
    const { building, room, fittings, notes, userKey, verifyNow } = req.body;
    
    const newStatus = verifyNow ? 'VERIFIED' : 'PENDING';

    await connection.query(
      'UPDATE inventory_records SET building = ?, room = ?, fittings = ?, notes = ?, status = ? WHERE id = ?',
      [building, room, JSON.stringify(fittings), notes, newStatus, id]
    );

    const actionType = verifyNow ? 'EDITED_AND_VERIFIED_BY_SDE' : 'EDITED_BY_SDE';
    await connection.query(
      'INSERT INTO record_history (record_id, action, performed_by) VALUES (?, ?, ?)',
      [id, actionType, userKey]
    );

    await connection.commit();
    res.json({ message: 'Record updated successfully' });
  } catch (err) {
    await connection.rollback();
    console.error(err.message);
    res.status(500).send('Server Error');
  } finally {
    connection.release();
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});
// Serve index.html when visiting the main root URL
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'pwd-inventory.html'));
});
