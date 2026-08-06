// Temporary: boot the app on an in-memory Mongo with a demo tenant + admin
// so the editor can be exercised in a browser.
const { MongoMemoryServer } = require('mongodb-memory-server');
(async () => {
  const mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri('chatbot_demo');
  process.env.PORT = '3999';
  process.env.NODE_ENV = 'development';
  process.env.OPENAI_API_KEY = '';
  require('./server.js');
  await new Promise(r => setTimeout(r, 3500));

  const Company = require('./models/company');
  const User = require('./models/user');
  const company = await Company.create({ name: 'Acme Co', allowedDomains: ['https://acme.example'] });
  await User.create({
    username: 'admin', email: 'admin@acme.example', password: 'password123',
    displayName: 'Ada Admin', role: 'company_admin', company: company._id
  });
  console.log('SEED_OK widgetKey=' + company.widgetKey);
  await new Promise(r => setTimeout(r, 3600000));
})();
