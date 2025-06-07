/**
 * Admin API routes for operations management
 */

const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const BackupService = require('../services/backup');
const WidgetUpdateService = require('../services/widgetUpdate');
const { logger } = require('../services/logging');

// Initialize services
const backupService = new BackupService();
const widgetUpdateService = new WidgetUpdateService();

// Get system status
router.get('/status', auth, async (req, res) => {
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

// Backup management routes
router.get('/backups', auth, async (req, res) => {
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

router.post('/backups/create', auth, async (req, res) => {
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

router.post('/backups/restore', auth, async (req, res) => {
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

// Widget version management routes
router.get('/widget/versions', auth, async (req, res) => {
  try {
    const versions = widgetUpdateService.getVersions();

    const versionDetails = versions.all.map(version =>
      widgetUpdateService.getVersionInfo(version)
    ).filter(info => info !== null);

    res.json({
      current: versions.current,
      latest: versions.latest,
      lastUpdated: versions.lastUpdated,
      versions: versionDetails
    });
  } catch (error) {
    logger.error('Error getting widget versions', { error });
    res.status(500).json({ error: 'Failed to get widget versions' });
  }
});

router.post('/widget/deploy', auth, async (req, res) => {
  try {
    const { version } = req.body;

    if (!version) {
      return res.status(400).json({ error: 'Version is required' });
    }

    const success = widgetUpdateService.deployVersion(version);

    if (success) {
      res.json({
        success: true,
        message: `Widget version ${version} deployed successfully`
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Deployment failed'
      });
    }
  } catch (error) {
    logger.error('Error deploying widget version', { error });
    res.status(500).json({ error: error.message || 'Failed to deploy widget version' });
  }
});

router.post('/widget/archive-current', auth, async (req, res) => {
  try {
    const success = widgetUpdateService.archiveCurrentVersion();

    if (success) {
      res.json({
        success: true,
        message: 'Current widget version archived successfully',
        version: widgetUpdateService.currentVersion
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Archiving failed'
      });
    }
  } catch (error) {
    logger.error('Error archiving widget version', { error });
    res.status(500).json({ error: 'Failed to archive widget version' });
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
