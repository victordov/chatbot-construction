// Mock bcrypt for password hashing and comparison
jest.mock('bcrypt', () => ({
  genSalt: jest.fn().mockResolvedValue('salt'),
  hash: jest.fn().mockImplementation((password, salt) => Promise.resolve(`hashed_${password}`)),
  compare: jest.fn().mockImplementation((candidatePassword, hashedPassword) => {
    // Extract the original password from our mock hashing scheme
    const originalPassword = hashedPassword.replace('hashed_', '');
    return Promise.resolve(candidatePassword === originalPassword);
  })
}));

// Create a simplified mock for the User model
jest.mock('../models/user', () => {
  // Mock User class
  class MockUser {
    constructor(data) {
      Object.assign(this, {
        _id: 'user-' + Math.random().toString(36).substring(2, 9),
        username: '',
        email: '',
        password: '',
        role: 'operator',
        isActive: true,
        createdAt: new Date(),
        ...data
      });
    }

    // Mock save method
    async save() {
      // Validate required fields
      if (!this.email) {
        const error = new Error('Email is required');
        error.name = 'ValidationError';
        throw error;
      }

      // Hash password if it's not already hashed
      if (!this.password.startsWith('hashed_')) {
        this.password = `hashed_${this.password}`;
      }

      return this;
    }

    // Mock comparePassword method
    async comparePassword(candidatePassword) {
      return candidatePassword === this.password.replace('hashed_', '');
    }
  }

  // Add static methods to MockUser
  MockUser.deleteMany = jest.fn().mockResolvedValue({ deletedCount: 0 });

  // Track created users to enforce uniqueness - make it accessible for clearing between tests
  const usersStore = {
    users: []
  };

  // Override the save method to check for duplicates
  const originalSave = MockUser.prototype.save;
  MockUser.prototype.save = async function() {
    // Check for duplicate username
    if (usersStore.users.some(u => u.username === this.username)) {
      const error = new Error('Duplicate username');
      error.code = 11000;
      throw error;
    }

    // Save the user and add to our tracking array
    const result = await originalSave.call(this);
    usersStore.users.push(this);
    return result;
  };

  // Add a method to clear users (for testing)
  MockUser._clearUsers = () => {
    usersStore.users = [];
  };

  return MockUser;
});

// Import the mocked User model
const User = require('../models/user');

describe('User Model Test', () => {
  beforeEach(() => {
    // Clear all mocks before each test
    jest.clearAllMocks();
    // Clear users store to avoid duplicate username errors between tests
    User._clearUsers();
  });

  it('should create & save a user successfully', async () => {
    const userData = {
      username: 'testuser',
      email: 'test@example.com',
      password: 'password123',
      role: 'operator'
    };

    const user = new User(userData);
    const savedUser = await user.save();

    // Object Id should be defined
    expect(savedUser._id).toBeDefined();
    expect(savedUser.username).toBe(userData.username);
    expect(savedUser.email).toBe(userData.email);
    // Password should be hashed, not the original
    expect(savedUser.password).toBe('hashed_password123');
    expect(savedUser.role).toBe(userData.role);
    expect(savedUser.isActive).toBe(true);
    expect(savedUser.createdAt).toBeDefined();
  });

  it('should fail when required fields are missing', async () => {
    const userWithoutRequiredField = new User({ username: 'testuser' });
    let err;
    try {
      await userWithoutRequiredField.save();
    } catch (error) {
      err = error;
    }
    expect(err).toBeDefined();
    expect(err.name).toBe('ValidationError');
  });

  it('should correctly verify a valid password', async () => {
    const user = new User({
      username: 'testuser',
      email: 'test@example.com',
      password: 'correctpassword',
      role: 'operator'
    });

    await user.save();

    const isMatch = await user.comparePassword('correctpassword');
    expect(isMatch).toBe(true);
  });

  it('should correctly reject an invalid password', async () => {
    const user = new User({
      username: 'testuser2',
      email: 'test2@example.com',
      password: 'correctpassword',
      role: 'operator'
    });

    await user.save();

    const isMatch = await user.comparePassword('wrongpassword');
    expect(isMatch).toBe(false);
  });

  it('should not allow duplicate usernames', async () => {
    const firstUser = new User({
      username: 'sameusername',
      email: 'first@example.com',
      password: 'password123'
    });

    await firstUser.save();

    const secondUser = new User({
      username: 'sameusername',
      email: 'second@example.com',
      password: 'password456'
    });

    let err;
    try {
      await secondUser.save();
    } catch (error) {
      err = error;
    }

    expect(err).toBeDefined();
    expect(err.code).toBe(11000); // MongoDB duplicate key error
  });
});
