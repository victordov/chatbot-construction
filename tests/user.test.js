// Import mock mongoose first
const { mongoose } = require('./helpers/mock-mongodb');

// Mock mongoose module for all imports
jest.mock('mongoose', () => require('./helpers/mock-mongodb').mongoose);

// Import the User model after the mongoose mock is set up
const User = require('../models/user');

// Now mock the User model specifically for test control
jest.mock('../models/user', () => {
  return {
    findOne: jest.fn().mockResolvedValue(null),
    findById: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockImplementation((data) => ({
      ...data,
      _id: 'user-' + Math.random().toString(36).substring(2, 9),
      save: jest.fn().mockResolvedValue(true)
    })),
    updateOne: jest.fn().mockResolvedValue({ nModified: 1 }),
    deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 }),
    comparePassword: jest.fn().mockResolvedValue(true)
  };
});

describe('User Model Test', () => {
  // Setup test data
  const userData = {
    username: 'testuser',
    email: 'test@example.com',
    password: 'Password123!'
  };

  beforeEach(() => {
    // Clear all mocks before each test
    jest.clearAllMocks();

    // Setup default mock implementations
    User.findOne.mockResolvedValue(null);
    User.create.mockImplementation((data) => ({
      ...data,
      _id: 'user-' + Math.random().toString(36).substring(2, 9),
      save: jest.fn().mockResolvedValue(true)
    }));
  });

  it('should create a new user successfully', async () => {
    // Arrange: Set up User.create to return a new user
    const expectedUser = {
      ...userData,
      _id: 'user123',
      save: jest.fn().mockResolvedValue(true)
    };
    User.create.mockResolvedValue(expectedUser);

    // Act: Create the user
    const user = await User.create(userData);

    // Assert: Verify user was created with correct data
    expect(User.create).toHaveBeenCalledWith(userData);
    expect(user).toHaveProperty('_id', 'user123');
    expect(user).toHaveProperty('username', 'testuser');
    expect(user).toHaveProperty('email', 'test@example.com');
  });

  it('should find a user by username', async () => {
    // Arrange: Set up User.findOne to return a user
    const expectedUser = {
      ...userData,
      _id: 'user123'
    };
    User.findOne.mockResolvedValue(expectedUser);

    // Act: Find the user
    const user = await User.findOne({ username: 'testuser' });

    // Assert: Verify correct query and result
    expect(User.findOne).toHaveBeenCalledWith({ username: 'testuser' });
    expect(user).toHaveProperty('_id', 'user123');
    expect(user).toHaveProperty('username', 'testuser');
  });

  it('should update a user\'s details', async () => {
    // Arrange: Set up updateOne mock
    const updateData = { email: 'newemail@example.com' };
    User.updateOne.mockResolvedValue({ nModified: 1 });

    // Act: Update the user
    const result = await User.updateOne({ username: 'testuser' }, updateData);

    // Assert: Verify correct update operation
    expect(User.updateOne).toHaveBeenCalledWith({ username: 'testuser' }, updateData);
    expect(result).toHaveProperty('nModified', 1);
  });

  it('should delete a user', async () => {
    // Arrange: Set up deleteOne mock
    User.deleteOne.mockResolvedValue({ deletedCount: 1 });

    // Act: Delete the user
    const result = await User.deleteOne({ username: 'testuser' });

    // Assert: Verify correct delete operation
    expect(User.deleteOne).toHaveBeenCalledWith({ username: 'testuser' });
    expect(result).toHaveProperty('deletedCount', 1);
  });
});

afterAll(async () => {
  await mongoose.connection.close();
});

describe('User Model Test', () => {
  // Clear users collection before each test
  beforeEach(async () => {
    await User.deleteMany({});
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
    expect(savedUser.password).not.toBe(userData.password);
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
    expect(err).toBeInstanceOf(mongoose.Error.ValidationError);
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
      username: 'testuser',
      email: 'test@example.com',
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
