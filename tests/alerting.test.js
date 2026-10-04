/**
 * Alerts describe the system, not a random number generator.
 *
 * The response-time and error-rate figures used to be `Math.random() * 3000`
 * against a 2000ms threshold and `Math.random() * 0.1` against 5% - so a
 * deployment with alerts enabled sent a "High Response Time" warning about one
 * check in three and a *critical* "High Error Rate" email about half the time,
 * forever, with no relationship to anything that had happened. Both are now
 * read from the real HTTP histogram inside `checkMetrics`.
 */

const AlertService = require('../services/alerting');
const { register, metricsMiddleware } = require('../services/monitoring');

/** Drive the real histogram the way an HTTP request would. */
function recordRequest({ durationMs = 100, statusCode = 200 } = {}) {
  const metric = register.getSingleMetric('http_request_duration_ms');

  metric.observe({ method: 'GET', route: '/api/test', status_code: statusCode }, durationMs);
}

function newService() {
  const service = new AlertService({ enabled: true, emailEnabled: false, recipients: [] });

  service.sendNotification = jest.fn();
  return service;
}

describe('alerting reads real metrics', () => {
  beforeEach(() => {
    register.getSingleMetric('http_request_duration_ms').reset();
  });

  it('exposes the middleware that feeds it', () => {
    expect(typeof metricsMiddleware).toBe('function');
  });

  it('says nothing on the first check, because it has no baseline yet', async () => {
    const service = newService();
    recordRequest({ durationMs: 9000, statusCode: 500 });

    await service.checkMetrics();

    expect(service.sendNotification).not.toHaveBeenCalled();
  });

  it('says nothing when no requests were served in the window', async () => {
    const service = newService();
    recordRequest();
    await service.checkMetrics();   // baseline

    await service.checkMetrics();   // no traffic since

    expect(service.sendNotification).not.toHaveBeenCalled();
  });

  it('stays quiet when the application is healthy', async () => {
    const service = newService();
    await service.checkMetrics();

    for (let i = 0; i < 20; i++) {
      recordRequest({ durationMs: 40, statusCode: 200 });
    }
    await service.checkMetrics();

    expect(service.sendNotification).not.toHaveBeenCalled();
  });

  it('warns when responses really are slow', async () => {
    const service = newService();
    await service.checkMetrics();

    for (let i = 0; i < 10; i++) {
      recordRequest({ durationMs: 4000, statusCode: 200 });
    }
    await service.checkMetrics();

    expect(service.sendNotification).toHaveBeenCalledTimes(1);

    const alert = service.sendNotification.mock.calls[0][0];
    expect(alert.title).toMatch(/High Response Time/);
    expect(alert.severity).toBe('warning');
    // The number in the message is the measurement, not a guess.
    expect(alert.message).toContain('4000ms');
    expect(alert.metrics.requests).toBe(10);
  });

  it('raises a critical alert when requests really are failing', async () => {
    const service = newService();
    await service.checkMetrics();

    for (let i = 0; i < 5; i++) {
      recordRequest({ durationMs: 20, statusCode: 500 });
    }
    for (let i = 0; i < 5; i++) {
      recordRequest({ durationMs: 20, statusCode: 200 });
    }
    await service.checkMetrics();

    const alert = service.sendNotification.mock.calls[0][0];
    expect(alert.title).toMatch(/High Error Rate/);
    expect(alert.severity).toBe('critical');
    expect(alert.metrics.errors).toBe(5);
    expect(alert.metrics.requests).toBe(10);
  });

  it('measures the window, not the lifetime of the process', async () => {
    const service = newService();
    await service.checkMetrics();

    // A bad minute...
    for (let i = 0; i < 50; i++) {
      recordRequest({ durationMs: 8000, statusCode: 500 });
    }
    await service.checkMetrics();
    service.sendNotification.mockClear();

    // ...followed by a good one resolves, rather than staying alight because
    // the cumulative average is still dragged up by history.
    for (let i = 0; i < 10; i++) {
      recordRequest({ durationMs: 30, statusCode: 200 });
    }
    await service.checkMetrics();

    const titles = service.sendNotification.mock.calls.map(call => call[0].title);
    expect(titles).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^\[RESOLVED\]/)
      ])
    );
    expect(titles.every(title => title.startsWith('[RESOLVED]'))).toBe(true);
  });

  it('does not treat a counter reset as a flood of good news', async () => {
    const service = newService();
    recordRequest({ durationMs: 5000, statusCode: 500 });
    await service.checkMetrics();

    register.getSingleMetric('http_request_duration_ms').reset();

    await expect(service.checkMetrics()).resolves.toBeUndefined();
    expect(service.sendNotification).not.toHaveBeenCalled();
  });
});
