// PDF generation service for chatbot application
// Uses 'pdfkit' for PDF creation
// Stores PDFs in filesystem and provides hooks for DB storage and chat attachment

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const ColumnConfig = require('../models/columnConfig');

const PDF_OUTPUT_DIR = path.join(__dirname, '../generated_pdfs');
if (!fs.existsSync(PDF_OUTPUT_DIR)) {
  fs.mkdirSync(PDF_OUTPUT_DIR);
}

async function generatePDF(type, data, chatId, saveToDbCallback, columns) {
  const doc = new PDFDocument();
  const filename = `${type}_${chatId}_${Date.now()}.pdf`;
  const filepath = path.join(PDF_OUTPUT_DIR, filename);
  const stream = fs.createWriteStream(filepath);
  doc.pipe(stream);

  // Render PDF content based on type
  if (type === 'payment_schedule') {
    renderPaymentSchedule(doc, data);
  } else if (type === 'mortgage_plan') {
    renderMortgagePlan(doc, data);
  } else if (type === 'apartment_info') {
    await renderApartmentInfo(doc, data, columns);
  } else {
    doc.text('Unknown PDF type');
  }

  doc.end();

  return new Promise((resolve, reject) => {
    stream.on('finish', async () => {
      try {
        // Optionally store in DB
        if (saveToDbCallback) {
          await saveToDbCallback({
            chatId,
            filename,
            filepath,
            createdAt: new Date()
          });
        }
        // Optionally attach to chat (implement in chat logic)
        resolve(filepath);
      } catch (error) {
        reject(error);
      }
    });

    stream.on('error', (error) => {
      reject(error);
    });
  });
}

function renderPaymentSchedule(doc, data) {
  doc.fontSize(18).text('Payment Schedule', { underline: true });
  doc.moveDown();
  // Example table rendering
  data.schedule.forEach((item, idx) => {
    doc.fontSize(12).text(`Payment ${idx + 1}: ${item.date} - $${item.amount}`);
  });
}

function renderMortgagePlan(doc, data) {
  doc.fontSize(18).text('Mortgage Plan Options', { underline: true });
  doc.moveDown();
  data.options.forEach((opt, idx) => {
    doc.fontSize(12).text(`Option ${idx + 1}: ${opt.description} - Rate: ${opt.rate}% - Term: ${opt.term} years`);
  });
}

async function renderApartmentInfo(doc, data, columns) {
  doc.fontSize(18).text('Apartment Information', { underline: true });
  doc.moveDown();

  // Render only selected columns if provided, otherwise use config from DB
  let cols = [];

  if (Array.isArray(columns) && columns.length > 0) {
    // Use provided columns
    cols = columns;
  } else {
    try {
      // Try to get configuration from database
      const config = await ColumnConfig.findOne({ type: 'apartment_info' });

      if (config && Array.isArray(config.columns) && config.columns.length > 0) {
        // Use only enabled columns from config, sorted by order
        cols = config.columns
          .filter(col => col.enabled)
          .sort((a, b) => a.order - b.order);
      } else {
        // Fall back to default columns if no config found
        cols = [
          { key: 'address', label: 'Address' },
          { key: 'size', label: 'Size (sq ft)' },
          { key: 'rooms', label: 'Rooms' },
          { key: 'price', label: 'Price' },
          { key: 'details', label: 'Details' }
        ];
      }
    } catch (error) {
      console.error('Error fetching column configuration:', error);
      // Fall back to default columns on error
      cols = [
        { key: 'address', label: 'Address' },
        { key: 'size', label: 'Size (sq ft)' },
        { key: 'rooms', label: 'Rooms' },
        { key: 'price', label: 'Price' },
        { key: 'details', label: 'Details' }
      ];
    }
  }

  // Render columns
  cols.forEach(col => {
    if (data[col.key] !== undefined && data[col.key] !== null) {
      doc.fontSize(12).text(`${col.label}: ${data[col.key]}`);
      doc.moveDown(0.2);
    }
  });
}

module.exports = {
  generatePDF,
  renderApartmentInfo // Export for admin config usage
};
