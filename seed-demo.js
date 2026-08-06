const { MongoMemoryServer } = require('mongodb-memory-server');
(async () => {
  const mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri('chatbot_demo');
  process.env.PORT = '3999';
  require('./server.js');
  await new Promise(r => setTimeout(r, 3500));

  const Company = require('./models/company');
  const User = require('./models/user');
  const Subscription = require('./models/subscription');
  const usage = require('./services/usage');
  const Usage = require('./models/usage');

  const acme = await Company.create({ name: 'Acme Co', allowedDomains: ['http://localhost:3999'] });
  const globex = await Company.create({ name: 'Globex Ltd' });

  await User.create({ username:'admin', email:'admin@acme.example', password:'password123',
    displayName:'Ada Admin', role:'company_admin', company: acme._id });
  await User.create({ username:'root', email:'root@platform.example', password:'password123',
    displayName:'Root', role:'superadmin' });

  const sub = await Subscription.forCompany(acme._id);
  sub.planId = 'professional'; sub.status = 'active'; sub.trialEndsAt = undefined;
  await sub.save();

  // Some seats so the seat meter is not empty
  for (let i = 0; i < 4; i++) {
    await User.create({ username:`op${i}`, email:`op${i}@acme.example`, password:'password123',
      role:'operator', company: acme._id });
  }

  await usage.record(acme._id, { conversations: 1840, messages: 7200, aiResponses: 6100, filesUploaded: 42, limitHits: 3 });
  await usage.record(globex._id, { conversations: 260, messages: 900, aiResponses: 700 });

  // A few prior months so the history chart has shape
  const now = new Date();
  for (let back = 1; back <= 5; back++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    await Usage.create({
      company: acme._id,
      period: `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`,
      conversations: 900 + back * 180, messages: 3000 + back * 400, aiResponses: 2500 + back * 350
    });
  }

  console.log('SEED_OK');
  await new Promise(r => setTimeout(r, 3600000));
})();
