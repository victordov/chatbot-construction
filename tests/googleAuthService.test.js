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

  it('generates auth url with a signed state rather than the bare user id', () => {
    const svc = new GoogleAuthService();
    const url = svc.generateAuthUrl('u1');
    expect(mockGenerateAuthUrl).toHaveBeenCalled();
    expect(url).toBe('http://auth.url');

    const { state } = mockGenerateAuthUrl.mock.calls[0][0];
    expect(state).not.toBe('u1');
    expect(svc.verifyState(state)).toBe('u1');
  });

  it('handles callback and saves token against the user the state names', async () => {
    GoogleToken.findOneAndUpdate = jest.fn().mockResolvedValue({});
    const svc = new GoogleAuthService();
    await svc.handleOAuthCallback(svc.signState('u1'), 'code');
    expect(mockGetToken).toHaveBeenCalledWith('code');
    expect(GoogleToken.findOneAndUpdate).toHaveBeenCalledWith(
      { userId: 'u1' },
      expect.anything(),
      expect.anything()
    );
  });

  describe('the OAuth state', () => {
    // Google hands the state back untouched, so a bare user id let anyone who
    // could reach the callback attach their Google account to somebody else's
    // login. The state is now signed, and every forgery below is refused
    // before any token is exchanged or stored.
    it('refuses a bare user id', async () => {
      GoogleToken.findOneAndUpdate = jest.fn();
      const svc = new GoogleAuthService();
      await expect(svc.handleOAuthCallback('u1', 'code')).rejects.toMatchObject({ code: 'INVALID_STATE' });
      expect(mockGetToken).not.toHaveBeenCalled();
      expect(GoogleToken.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('refuses a state whose user id was swapped after signing', () => {
      const svc = new GoogleAuthService();
      const [, issuedAt, signature] = svc.signState('u1').split('.');
      expect(svc.verifyState(`u2.${issuedAt}.${signature}`)).toBeNull();
    });

    it('refuses a state older than ten minutes', () => {
      const svc = new GoogleAuthService();
      const realNow = Date.now;
      Date.now = () => realNow() - 11 * 60 * 1000;
      let stale;
      try {
        stale = svc.signState('u1');
      } finally {
        Date.now = realNow;
      }
      expect(svc.verifyState(stale)).toBeNull();
    });

    it('refuses a state signed with another secret', () => {
      const svc = new GoogleAuthService();
      const original = process.env.JWT_SECRET;
      process.env.JWT_SECRET = 'somebody-elses-secret';
      let foreign;
      try {
        foreign = svc.signState('u1');
      } finally {
        process.env.JWT_SECRET = original;
      }
      expect(svc.verifyState(foreign)).toBeNull();
    });
  });
});
