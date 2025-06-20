/**
 * Backup and Disaster Recovery Service for Chatbot Application
 *
 * This service provides functionality for database backups,
 * configuration backups, and system restoration.
 */

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const execAsync = promisify(exec);
const { logger } = require('./logging');

class BackupService {
  constructor(options = {}) {
    this.mongoUri = options.mongoUri || process.env.MONGODB_URI;
    this.backupDir = options.backupDir || path.join(__dirname, '..', 'backups');
    this.configFiles = options.configFiles || [
      '.env',
      'package.json',
      'package-lock.json',
      'server.js'
    ];
    this.retentionDays = options.retentionDays || parseInt(process.env.BACKUP_RETENTION_DAYS || '30');
    this.scheduleInterval = options.scheduleInterval || parseInt(process.env.BACKUP_INTERVAL_HOURS || '24') * 60 * 60 * 1000;

    // Create backup directory if it doesn't exist
    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
    }
  }

  /**
   * Start the backup schedule
   */
  start() {
    logger.info(`Starting backup service with ${this.retentionDays} days retention`);

    // Run an initial backup
    this.performBackup();

    // Schedule regular backups
    this.scheduleTimer = setInterval(() => {
      this.performBackup();
    }, this.scheduleInterval);

    // Schedule cleanup of old backups
    this.cleanupTimer = setInterval(() => {
      this.cleanupOldBackups();
    }, 24 * 60 * 60 * 1000); // Daily cleanup
  }

  /**
   * Stop the backup schedule
   */
  stop() {
    if (this.scheduleTimer) {
      clearInterval(this.scheduleTimer);
    }

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }

    logger.info('Backup service stopped');
  }

  /**
   * Perform a full backup of the database and configuration
   */
  async performBackup() {
    const timestamp = new Date().toISOString().replace(/:/g, '-');
    const backupPath = path.join(this.backupDir, timestamp);

    // Create backup directory for this backup
    fs.mkdirSync(backupPath, { recursive: true });

    try {
      // Backup MongoDB database
      await this.backupDatabase(backupPath);

      // Backup configuration files
      await this.backupConfigs(backupPath);

      logger.info(`Backup completed successfully at ${timestamp}`);
      return { success: true, timestamp, path: backupPath };
    } catch (error) {
      logger.error(`Backup failed: ${error.message}`, { error });
      return { success: false, error: error.message };
    }
  }

  /**
   * Backup MongoDB database using mongodump
   */
  async backupDatabase(backupPath) {
    if (!this.mongoUri) {
      throw new Error('MongoDB URI not configured');
    }

    const dbBackupPath = path.join(backupPath, 'db');
    fs.mkdirSync(dbBackupPath, { recursive: true });

    logger.info('Starting database backup');

    try {
      // Check if mongodump is installed
      try {
        await execAsync('which mongodump || command -v mongodump');
      } catch (cmdError) {
        throw new Error(
          'mongodump command not found. MongoDB Database Tools are required for backups.\n' +
          'Installation instructions:\n' +
          '- For macOS: brew install mongodb-database-tools\n' +
          '- For Ubuntu/Debian: sudo apt-get install mongodb-database-tools\n' +
          '- For Windows: Download from https://www.mongodb.com/try/download/database-tools\n' +
          'After installation, ensure the tools are in your system PATH.'
        );
      }

      // Use mongodump to backup the database
      const command = `mongodump --uri="${this.mongoUri}" --out="${dbBackupPath}"`;
      await execAsync(command);

      logger.info('Database backup completed');
      return true;
    } catch (error) {
      logger.error(`Database backup failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Backup configuration files
   */
  async backupConfigs(backupPath) {
    const configBackupPath = path.join(backupPath, 'config');
    fs.mkdirSync(configBackupPath, { recursive: true });

    logger.info('Starting configuration backup');

    try {
      for (const file of this.configFiles) {
        const srcPath = path.join(__dirname, '..', file);
        const destPath = path.join(configBackupPath, file);

        if (fs.existsSync(srcPath)) {
          fs.copyFileSync(srcPath, destPath);
          logger.debug(`Backed up ${file}`);
        } else {
          logger.warn(`Config file not found: ${file}`);
        }
      }

      logger.info('Configuration backup completed');
      return true;
    } catch (error) {
      logger.error(`Configuration backup failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Clean up backups older than retention period
   */
  async cleanupOldBackups() {
    logger.info(`Cleaning up backups older than ${this.retentionDays} days`);

    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - this.retentionDays);

      const entries = fs.readdirSync(this.backupDir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const dirPath = path.join(this.backupDir, entry.name);
          const stats = fs.statSync(dirPath);

          if (stats.mtime < cutoffDate) {
            logger.info(`Removing old backup: ${entry.name}`);
            this.removeDirectory(dirPath);
          }
        }
      }

      logger.info('Backup cleanup completed');
    } catch (error) {
      logger.error(`Backup cleanup failed: ${error.message}`);
    }
  }

  /**
   * Remove a directory and all its contents
   */
  removeDirectory(dirPath) {
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  }

  /**
   * Restore from a backup
   */
  async restore(backupTimestamp) {
    const backupPath = path.join(this.backupDir, backupTimestamp);

    if (!fs.existsSync(backupPath)) {
      throw new Error(`Backup ${backupTimestamp} not found`);
    }

    logger.info(`Starting restoration from backup: ${backupTimestamp}`);

    try {
      // Restore database
      await this.restoreDatabase(backupPath);

      // Restore configs (usually done manually to avoid overwriting current configs)
      // await this.restoreConfigs(backupPath);

      logger.info(`Restoration from ${backupTimestamp} completed successfully`);
      return { success: true };
    } catch (error) {
      logger.error(`Restoration failed: ${error.message}`, { error });
      return { success: false, error: error.message };
    }
  }

  /**
   * Restore MongoDB database from backup
   */
  async restoreDatabase(backupPath) {
    if (!this.mongoUri) {
      throw new Error('MongoDB URI not configured');
    }

    const dbBackupPath = path.join(backupPath, 'db');

    if (!fs.existsSync(dbBackupPath)) {
      throw new Error('Database backup not found');
    }

    logger.info('Starting database restoration');

    try {
      // Check if mongorestore is installed
      try {
        await execAsync('which mongorestore || command -v mongorestore');
      } catch (cmdError) {
        throw new Error(
          'mongorestore command not found. MongoDB Database Tools are required for restoration.\n' +
          'Installation instructions:\n' +
          '- For macOS: brew install mongodb-database-tools\n' +
          '- For Ubuntu/Debian: sudo apt-get install mongodb-database-tools\n' +
          '- For Windows: Download from https://www.mongodb.com/try/download/database-tools\n' +
          'After installation, ensure the tools are in your system PATH.'
        );
      }

      // Use mongorestore to restore the database
      const command = `mongorestore --uri="${this.mongoUri}" --drop "${dbBackupPath}"`;
      await execAsync(command);

      logger.info('Database restoration completed');
      return true;
    } catch (error) {
      logger.error(`Database restoration failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * List available backups
   */
  listBackups() {
    try {
      const entries = fs.readdirSync(this.backupDir, { withFileTypes: true });

      const backups = entries
        .filter(entry => entry.isDirectory())
        .map(entry => {
          const dirPath = path.join(this.backupDir, entry.name);
          const stats = fs.statSync(dirPath);

          return {
            timestamp: entry.name,
            created: stats.mtime,
            path: dirPath,
            size: this.getDirSize(dirPath)
          };
        })
        .sort((a, b) => b.created - a.created); // Newest first

      return backups;
    } catch (error) {
      logger.error(`Failed to list backups: ${error.message}`);
      return [];
    }
  }

  /**
   * Get directory size in bytes
   */
  getDirSize(dirPath) {
    let size = 0;

    const files = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const file of files) {
      const filePath = path.join(dirPath, file.name);

      if (file.isDirectory()) {
        size += this.getDirSize(filePath);
      } else {
        const stats = fs.statSync(filePath);
        size += stats.size;
      }
    }

    return size;
  }
}

module.exports = BackupService;
