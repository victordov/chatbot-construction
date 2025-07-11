const KnowledgeDocument = require('../models/knowledgeDocument');
const GoogleSheetsService = require('./googleSheets');
const { logger } = require('./logging');

class KnowledgeService {
  constructor() {
    this.sheetsService = new GoogleSheetsService();
  }

  async importSpreadsheet(userId, spreadsheetId, sheet = 'Sheet1', exclude = []) {
    try {
      const { title } = await this.sheetsService.getSheetNames(userId, spreadsheetId);
      const sheetData = await this.sheetsService.getSheetData(userId, spreadsheetId, sheet);
      const columns = sheetData.header.map(name => ({ name, exclude: exclude.includes(name) }));
      const doc = await KnowledgeDocument.findOneAndUpdate(
        { userId, spreadsheetId },
        { title: title || spreadsheetId, sheet, columns, rows: sheetData.rows },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      );
      return doc;
    } catch (error) {
      logger.error('Error importing spreadsheet', { error });
      throw error;
    }
  }

  async list(userId, query = '') {
    const q = query
      ? { $or: [
          { title: { $regex: query, $options: 'i' } },
          { spreadsheetId: { $regex: query, $options: 'i' } }
        ] }
      : {};
    return KnowledgeDocument.find({ userId, ...q }).select('spreadsheetId title sheet createdAt');
  }

  async get(userId, id) {
    return KnowledgeDocument.findOne({ _id: id, userId });
  }

  async refresh(userId, id) {
    try {
      const doc = await KnowledgeDocument.findOne({ _id: id, userId });
      if (!doc) throw new Error('Document not found');
      const excludeMap = doc.columns.reduce((acc, c) => { acc[c.name] = c.exclude; return acc; }, {});
      const { title } = await this.sheetsService.getSheetNames(userId, doc.spreadsheetId);
      const sheetData = await this.sheetsService.getSheetData(userId, doc.spreadsheetId, doc.sheet || 'Sheet1');
      doc.columns = sheetData.header.map(name => ({ name, exclude: excludeMap[name] || false }));
      doc.rows = sheetData.rows;
      if (title) doc.title = title;
      await doc.save();
      return doc;
    } catch (error) {
      logger.error('Error refreshing spreadsheet', { error });
      throw error;
    }
  }

  async updateColumns(userId, id, excluded) {
    try {
      const doc = await KnowledgeDocument.findOne({ _id: id, userId });
      if (!doc) throw new Error('Document not found');
      doc.columns.forEach(col => { col.exclude = excluded.includes(col.name); });
      await doc.save();
      return doc;
    } catch (error) {
      logger.error('Error updating excluded columns', { error });
      throw error;
    }
  }

  async delete(userId, id) {
    try {
      await KnowledgeDocument.deleteOne({ _id: id, userId });
    } catch (error) {
      logger.error('Error deleting knowledge document', { error });
      throw error;
    }
  }
}

module.exports = KnowledgeService;
