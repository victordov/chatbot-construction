/**
 * Admin API routes for operations management
 */

const express = require('express');
const router = express.Router();
const { auth, admin, superadmin } = require('../middleware/auth');
const BackupService = require('../services/backup');
const TenantBackupService = require('../services/tenant-backup');
const Company = require('../models/company');
const audit = require('../services/audit');
const { logger } = require('../services/logging');

// Initialize services
const backupService = new BackupService();
const tenantBackupService = new TenantBackupService();

// Get system status
router.get('/status', auth, admin, async (req, res) => {
  try {
    // Get basic system information
    const memoryUsage = process.memoryUsage();
    const uptime = process.uptime();

    res.json({
      status: 'ok',
      version: process.env.npm_package_version || '1.0.0',
      uptime: uptime,
      memory: {
        rss: Math.round(memoryUsage.rss / 1024 / 1024) + ' MB',
        heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024) + ' MB',
        heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024) + ' MB',
        external: Math.round(memoryUsage.external / 1024 / 1024) + ' MB'
      },
      environment: process.env.NODE_ENV || 'development'
    });
  } catch (error) {
    logger.error('Error getting system status', { error });
    res.status(500).json({ error: 'Failed to get system status' });
  }
});

/**
 * Per-tenant backup.
 *
 * The whole-database backup below answers "we lost the server". These answer
 * "one customer lost their data", which is the far more common accident and
 * the one a full restore handles appallingly: rolling every tenant back to
 * last night to undo one company's mistake trades their bad day for everyone
 * else's.
 */
router.post('/companies/:companyId/backups', auth, superadmin, async (req, res) => {
  try {
    const company = await Company.findById(req.params.companyId).lean();

    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    const manifest = await tenantBackupService.backupCompany(company._id);

    await audit.record({
      action: 'tenant_backup.created',
      req,
      company: String(company._id),
      target: { type: 'company', id: String(company._id), label: company.name },
      details: { timestamp: manifest.timestamp, documents: manifest.documents }
    });

    res.json({ success: true, backup: manifest });
  } catch (error) {
    logger.error('Tenant backup failed', { error: error.message });
    res.status(500).json({ error: error.message || 'Backup failed' });
  }
});

router.get('/companies/:companyId/backups', auth, superadmin, async (req, res) => {
  try {
    res.json({ backups: tenantBackupService.listBackups(req.params.companyId) });
  } catch (error) {
    logger.error('Listing tenant backups failed', { error: error.message });
    res.status(400).json({ error: error.message });
  }
});

router.post('/companies/:companyId/backups/:timestamp/restore', auth, superadmin, async (req, res) => {
  try {
    const company = await Company.findById(req.params.companyId).lean();

    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    // `replace` drops whatever has happened since the backup was taken, so it
    // has to be asked for in as many words rather than reached by leaving a
    // field blank.
    const mode = req.body && req.body.mode === 'replace' ? 'replace' : 'merge';

    if (mode === 'replace' && req.body.confirm !== company.name) {
      return res.status(400).json({
        error: 'Replacing a tenant\'s data discards everything since the backup. '
          + `Send confirm: "${company.name}" to proceed.`
      });
    }

    const result = await tenantBackupService.restoreCompany(company._id, req.params.timestamp, { mode });

    await audit.record({
      action: 'tenant_backup.restored',
      req,
      company: String(company._id),
      target: { type: 'company', id: String(company._id), label: company.name },
      details: { timestamp: req.params.timestamp, mode, restored: result.restored, removed: result.removed }
    });

    res.json({ success: true, result });
  } catch (error) {
    logger.error('Tenant restore failed', { error: error.message });
    res.status(400).json({ error: error.message });
  }
});

// Backup management routes
router.get('/backups', auth, superadmin, async (req, res) => {
  try {
    const backups = backupService.listBackups();

    res.json({
      backups: backups.map(backup => ({
        timestamp: backup.timestamp,
        created: backup.created,
        size: formatBytes(backup.size)
      }))
    });
  } catch (error) {
    logger.error('Error listing backups', { error });
    res.status(500).json({ error: 'Failed to list backups' });
  }
});

router.post('/backups/create', auth, superadmin, async (req, res) => {
  try {
    const result = await backupService.performBackup();

    if (result.success) {
      res.json({
        success: true,
        message: 'Backup created successfully',
        timestamp: result.timestamp
      });
    } else {
      res.status(500).json({
        success: false,
        error: result.error || 'Backup failed'
      });
    }
  } catch (error) {
    logger.error('Error creating backup', { error });
    res.status(500).json({ error: 'Failed to create backup' });
  }
});

router.post('/backups/restore', auth, superadmin, async (req, res) => {
  try {
    const { timestamp } = req.body;

    if (!timestamp) {
      return res.status(400).json({ error: 'Timestamp is required' });
    }

    const result = await backupService.restore(timestamp);

    if (result.success) {
      res.json({
        success: true,
        message: 'Restoration completed successfully'
      });
    } else {
      res.status(500).json({
        success: false,
        error: result.error || 'Restoration failed'
      });
    }
  } catch (error) {
    logger.error('Error restoring backup', { error });
    res.status(500).json({ error: 'Failed to restore backup' });
  }
});

// Helper function to format bytes
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) {
    return '0 Bytes';
  }

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

module.exports = router;
