const GoogleAuthService = require('../services/googleAuth');
const GoogleToken = require('../models/googleToken');

jest.mock('../models/googleToken');

const mockGetAccessToken = jest.fn().mockResolvedValue('newAccess');
const mockGenerateAuthUrl = jest.fn().mockReturnValue('http://auth.url');
const mockGetToken = jest.fn().mockResolvedValue({ tokens: { access_token: 'a', refresh_token: 'r' } });
const mockOn = jest.fn();

jest.mock('googleapis', () => {
  return {
    google: {
      auth: {
        OAuth2: jest.fn().mockImplementation(() => ({
          setCredentials: jest.fn(),
          on: mockOn,
          getAccessToken: mockGetAccessToken,
          generateAuthUrl: mockGenerateAuthUrl,
          getToken: mockGetToken
        }))
      }
    }
  };
});

describe('GoogleAuthService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('saves tokens using the model', async () => {
    GoogleToken.findOneAndUpdate = jest.fn().mockResolvedValue({ userId: 'u1' });
    const svc = new GoogleAuthService();
    const res = await svc.saveTokens('u1', { access_token: 'a', refresh_token: 'r' });
    expect(GoogleToken.findOneAndUpdate).toHaveBeenCalledWith(
      { userId: 'u1' },
      expect.objectContaining({ accessToken: 'a', refreshToken: 'r' }),
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    expect(res).toEqual({ userId: 'u1' });
  });

  it('refreshes expired token on retrieval', async () => {
    GoogleToken.findOne = jest.fn().mockResolvedValue({
      accessToken: 'x',
      refreshToken: 'r',
      scope: 's',
      tokenType: 'Bearer',
      expiryDate: 0
    });
    const svc = new GoogleAuthService();
    await svc.getOAuthClient('u1');
    expect(mockGetAccessToken).toHaveBeenCalled();
  });

  it('generates auth url', () => {
    const svc = new GoogleAuthService();
    const url = svc.generateAuthUrl('state');
    expect(mockGenerateAuthUrl).toHaveBeenCalled();
    expect(url).toBe('http://auth.url');
  });

  it('handles callback and saves token', async () => {
    GoogleToken.findOneAndUpdate = jest.fn().mockResolvedValue({});
    const svc = new GoogleAuthService();
    await svc.handleOAuthCallback('u1', 'code');
    expect(mockGetToken).toHaveBeenCalledWith('code');
    expect(GoogleToken.findOneAndUpdate).toHaveBeenCalled();
  });
});
