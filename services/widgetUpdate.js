/**
 * Widget Update Service for Chatbot Application
 *
 * This service provides mechanisms for updating the client-side widget
 * and managing version control for the widget.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { logger } = require('./logging');

class WidgetUpdateService {
  constructor(options = {}) {
    this.widgetDir = options.widgetDir || path.join(__dirname, '..', 'public', 'widget');
    this.versionsDir = options.versionsDir || path.join(__dirname, '..', 'widget-versions');
    this.currentVersion = options.currentVersion || '1.0.0';
    this.updateCheckInterval = options.updateCheckInterval || 3600000; // 1 hour

    // Create versions directory if it doesn't exist
    if (!fs.existsSync(this.versionsDir)) {
      fs.mkdirSync(this.versionsDir, { recursive: true });
    }

    // Initialize version info
    this.versionInfo = this.loadVersionInfo();
  }

  /**
   * Start the update service
   */
  start() {
    logger.info(`Starting widget update service, current version: ${this.currentVersion}`);

    // Check if initial version archive exists, if not create it
    if (!this.versionInfo.versions.includes(this.currentVersion)) {
      this.archiveCurrentVersion();
    }

    // Set up interval to check for updates
    this.updateTimer = setInterval(() => {
      this.checkForUpdates();
    }, this.updateCheckInterval);
  }

  /**
   * Stop the update service
   */
  stop() {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
    }

    logger.info('Widget update service stopped');
  }

  /**
   * Load version information from disk
   */
  loadVersionInfo() {
    const versionFilePath = path.join(this.versionsDir, 'versions.json');

    if (fs.existsSync(versionFilePath)) {
      try {
        return JSON.parse(fs.readFileSync(versionFilePath, 'utf8'));
      } catch (error) {
        logger.error(`Failed to parse version info: ${error.message}`);
      }
    }

    // Default version info
    return {
      currentVersion: this.currentVersion,
      latestVersion: this.currentVersion,
      versions: [this.currentVersion],
      lastUpdated: new Date().toISOString()
    };
  }

  /**
   * Save version information to disk
   */
  saveVersionInfo() {
    const versionFilePath = path.join(this.versionsDir, 'versions.json');

    try {
      fs.writeFileSync(
        versionFilePath,
        JSON.stringify(this.versionInfo, null, 2)
      );
    } catch (error) {
      logger.error(`Failed to save version info: ${error.message}`);
    }
  }

  /**
   * Archive the current version of the widget
   */
  archiveCurrentVersion() {
    const version = this.currentVersion;
    const versionDir = path.join(this.versionsDir, version);

    logger.info(`Archiving current widget version: ${version}`);

    try {
      // Create version directory
      if (!fs.existsSync(versionDir)) {
        fs.mkdirSync(versionDir, { recursive: true });
      }

      // Copy all widget files to version directory
      this.copyDirectoryContents(this.widgetDir, versionDir);

      // Generate checksum for the version
      const checksum = this.generateDirectoryChecksum(versionDir);

      // Update version info
      if (!this.versionInfo.versions.includes(version)) {
        this.versionInfo.versions.push(version);
        this.versionInfo.versions.sort((a, b) => {
          return this.compareVersions(a, b);
        });
      }

      this.versionInfo.checksums = this.versionInfo.checksums || {};
      this.versionInfo.checksums[version] = checksum;
      this.versionInfo.lastUpdated = new Date().toISOString();

      // Save updated version info
      this.saveVersionInfo();

      logger.info(`Successfully archived version ${version} with checksum ${checksum}`);
      return true;
    } catch (error) {
      logger.error(`Failed to archive version ${version}: ${error.message}`);
      return false;
    }
  }

  /**
   * Deploy a specific version of the widget
   */
  deployVersion(version) {
    if (!this.versionInfo.versions.includes(version)) {
      throw new Error(`Version ${version} not found`);
    }

    const versionDir = path.join(this.versionsDir, version);

    logger.info(`Deploying widget version: ${version}`);

    try {
      // Backup current version
      const backupDir = path.join(this.versionsDir, '_backup_' + new Date().toISOString().replace(/:/g, '-'));
      this.copyDirectoryContents(this.widgetDir, backupDir);

      // Clear current widget directory
      this.clearDirectory(this.widgetDir);

      // Copy version files to widget directory
      this.copyDirectoryContents(versionDir, this.widgetDir);

      // Update current version
      this.currentVersion = version;
      this.versionInfo.currentVersion = version;
      this.versionInfo.lastUpdated = new Date().toISOString();

      // Save updated version info
      this.saveVersionInfo();

      logger.info(`Successfully deployed version ${version}`);
      return true;
    } catch (error) {
      logger.error(`Failed to deploy version ${version}: ${error.message}`);

      // Try to restore from backup if deployment failed
      try {
        const backupDirs = fs.readdirSync(this.versionsDir)
          .filter(name => name.startsWith('_backup_'))
          .sort()
          .reverse();

        if (backupDirs.length > 0) {
          const latestBackup = path.join(this.versionsDir, backupDirs[0]);
          this.clearDirectory(this.widgetDir);
          this.copyDirectoryContents(latestBackup, this.widgetDir);
          logger.info(`Restored widget from backup: ${backupDirs[0]}`);
        }
      } catch (restoreError) {
        logger.error(`Failed to restore from backup: ${restoreError.message}`);
      }

      return false;
    }
  }

  /**
   * Check for updates to the widget
   */
  async checkForUpdates() {
    logger.debug('Checking for widget updates');

    // This would typically check a remote server or repository for updates
    // For now, we'll just check if the current files match the archived version

    try {
      const currentChecksum = this.generateDirectoryChecksum(this.widgetDir);
      const archivedChecksum = this.versionInfo.checksums?.[this.currentVersion];

      if (currentChecksum !== archivedChecksum) {
        logger.info('Widget files have been modified, creating new version');

        // Create new version
        const newVersion = this.incrementVersion(this.currentVersion);
        this.currentVersion = newVersion;

        // Archive new version
        this.archiveCurrentVersion();

        // Update latest version
        this.versionInfo.latestVersion = newVersion;
        this.saveVersionInfo();

        logger.info(`Created new widget version: ${newVersion}`);
      } else {
        logger.debug('Widget is up to date');
      }
    } catch (error) {
      logger.error(`Update check failed: ${error.message}`);
    }
  }

  /**
   * Generate a checksum for a directory
   */
  generateDirectoryChecksum(dirPath) {
    const fileHashes = [];

    // Get all files recursively
    const getFilesRecursively = (dir) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          getFilesRecursively(fullPath);
        } else {
          const fileContent = fs.readFileSync(fullPath);
          const hash = crypto.createHash('sha256').update(fileContent).digest('hex');
          const relativePath = path.relative(dirPath, fullPath).replace(/\\/g, '/');
          fileHashes.push(`${relativePath}:${hash}`);
        }
      }
    };

    getFilesRecursively(dirPath);

    // Sort to ensure consistent order
    fileHashes.sort();

    // Create overall hash
    return crypto.createHash('sha256').update(fileHashes.join('|')).digest('hex');
  }

  /**
   * Copy directory contents recursively
   */
  copyDirectoryContents(sourceDir, targetDir) {
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const entries = fs.readdirSync(sourceDir, { withFileTypes: true });

    for (const entry of entries) {
      const sourcePath = path.join(sourceDir, entry.name);
      const targetPath = path.join(targetDir, entry.name);

      if (entry.isDirectory()) {
        this.copyDirectoryContents(sourcePath, targetPath);
      } else {
        fs.copyFileSync(sourcePath, targetPath);
      }
    }
  }

  /**
   * Clear directory contents
   */
  clearDirectory(dirPath) {
    if (fs.existsSync(dirPath)) {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const entryPath = path.join(dirPath, entry.name);

        if (entry.isDirectory()) {
          fs.rmSync(entryPath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(entryPath);
        }
      }
    }
  }

  /**
   * Increment version number
   */
  incrementVersion(version) {
    const parts = version.split('.').map(Number);
    parts[2] += 1; // Increment patch version

    // Handle overflow
    if (parts[2] > 99) {
      parts[2] = 0;
      parts[1] += 1;
    }

    if (parts[1] > 99) {
      parts[1] = 0;
      parts[0] += 1;
    }

    return parts.join('.');
  }

  /**
   * Compare version strings
   */
  compareVersions(a, b) {
    const partsA = a.split('.').map(Number);
    const partsB = b.split('.').map(Number);

    for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
      const partA = partsA[i] || 0;
      const partB = partsB[i] || 0;

      if (partA > partB) {
        return 1;
      }
      if (partA < partB) {
        return -1;
      }
    }

    return 0;
  }

  /**
   * Get available versions
   */
  getVersions() {
    return {
      current: this.versionInfo.currentVersion,
      latest: this.versionInfo.latestVersion,
      all: this.versionInfo.versions,
      lastUpdated: this.versionInfo.lastUpdated
    };
  }

  /**
   * Get information about a specific version
   */
  getVersionInfo(version) {
    if (!this.versionInfo.versions.includes(version)) {
      return null;
    }

    const versionDir = path.join(this.versionsDir, version);

    if (!fs.existsSync(versionDir)) {
      return null;
    }

    const stats = fs.statSync(versionDir);

    return {
      version,
      created: stats.birthtime,
      checksum: this.versionInfo.checksums?.[version],
      isCurrent: version === this.versionInfo.currentVersion,
      isLatest: version === this.versionInfo.latestVersion
    };
  }
}

module.exports = WidgetUpdateService;
