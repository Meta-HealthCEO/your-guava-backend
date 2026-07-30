const { isSafeSeedMongoUri } = require('../../src/utils/seedMongoSafety');

describe('seed MongoDB target safety', () => {
  test.each([
    'mongodb://localhost:27017/guava',
    'mongodb://LOCALHOST/guava',
    'mongodb://127.0.0.1:27017/guava',
    'mongodb://127.42.10.9/guava',
    'mongodb://127.255.255.255/guava',
    'mongodb://[::1]:27017/guava',
    'mongodb://user:password@localhost:27017/guava?authSource=admin',
  ])('allows one loopback MongoDB host outside production: %s', (uri) => {
    expect(isSafeSeedMongoUri(uri, 'development')).toBe(true);
  });

  test.each([
    'mongodb://localhost:27017/guava',
    'mongodb://127.0.0.1:27017/guava',
    'mongodb://[::1]:27017/guava',
  ])('always rejects production: %s', (uri) => {
    expect(isSafeSeedMongoUri(uri, 'production')).toBe(false);
    expect(isSafeSeedMongoUri(uri, ' Production ')).toBe(false);
  });

  test.each([
    'mongodb://localhost.evil.example/guava',
    'mongodb://user:localhost@db.example.com/guava',
    'mongodb://localhost:password@db.example.com/guava',
    'mongodb://db.example.com/localhost',
    'mongodb://db.example.com/guava?target=localhost',
    'mongodb://db.example.com/guava?target=127.0.0.1',
  ])('rejects remote hosts even when another URI component contains loopback text: %s', (uri) => {
    expect(isSafeSeedMongoUri(uri, 'development')).toBe(false);
  });

  test.each([
    'mongodb://localhost:27017,127.0.0.1:27018/guava',
    'mongodb://localhost:27017,db.example.com:27017/guava',
    'mongodb://[::1]:27017,localhost:27018/guava',
  ])('rejects every multi-host URI: %s', (uri) => {
    expect(isSafeSeedMongoUri(uri, 'test')).toBe(false);
  });

  test.each([
    undefined,
    '',
    ' localhost ',
    'mongodb+srv://localhost/guava',
    'http://localhost:27017/guava',
    'mongodb://localhost:0/guava',
    'mongodb://localhost:65536/guava',
    'mongodb://127.0.0.1:abc/guava',
    'mongodb://127.0.0.1 @db.example.com/guava',
    'mongodb://user@name@localhost/guava',
    'mongodb://::1/guava',
    'mongodb://[::1/guava',
    'mongodb://127.0.0.1%ZZ/guava',
    'mongodb://127.01.0.1/guava',
    'mongodb://2130706433/guava',
  ])('fails closed for malformed or ambiguous input: %s', (uri) => {
    expect(isSafeSeedMongoUri(uri, 'development')).toBe(false);
  });
});
