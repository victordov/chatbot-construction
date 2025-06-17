const KnowledgeDocument = require('../models/knowledgeDocument');
const GoogleSheetsService = require('./googleSheets');

class KnowledgeService {
  constructor() {
    this.sheetsService = new GoogleSheetsService();
  }

  async importSpreadsheet(userId, spreadsheetId, exclude = []) {
    const sheet = await this.sheetsService.getSheetData(userId, spreadsheetId, 'Sheet1');
    const columns = sheet.header.map(name => ({ name, exclude: exclude.includes(name) }));
    const doc = await KnowledgeDocument.findOneAndUpdate(
      { userId, spreadsheetId },
      { title: spreadsheetId, columns, rows: sheet.rows },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    return doc;
  }

  async list(userId, query = '') {
    const q = query
      ? { $or: [
          { title: { $regex: query, $options: 'i' } },
          { spreadsheetId: { $regex: query, $options: 'i' } }
        ] }
      : {};
    return KnowledgeDocument.find({ userId, ...q }).select('spreadsheetId title createdAt');
  }

  async get(userId, id) {
    return KnowledgeDocument.findOne({ _id: id, userId });
  }

  async refresh(userId, id) {
    const doc = await KnowledgeDocument.findOne({ _id: id, userId });
    if (!doc) throw new Error('Document not found');
    const excludeMap = doc.columns.reduce((acc, c) => { acc[c.name] = c.exclude; return acc; }, {});
    const sheet = await this.sheetsService.getSheetData(userId, doc.spreadsheetId, 'Sheet1');
    doc.columns = sheet.header.map(name => ({ name, exclude: excludeMap[name] || false }));
    doc.rows = sheet.rows;
    await doc.save();
    return doc;
  }

  async updateColumns(userId, id, excluded) {
    const doc = await KnowledgeDocument.findOne({ _id: id, userId });
    if (!doc) throw new Error('Document not found');
    doc.columns.forEach(col => { col.exclude = excluded.includes(col.name); });
    await doc.save();
    return doc;
  }
}

module.exports = KnowledgeService;
