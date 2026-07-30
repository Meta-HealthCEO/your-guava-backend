const MONGODB_SCHEME = 'mongodb://';

const hasValidPercentEncoding = (value) => !/%(?![0-9a-f]{2})/i.test(value);

const isValidPort = (value) => {
  if (!/^\d{1,5}$/.test(value)) return false;
  const port = Number(value);
  return port >= 1 && port <= 65535;
};

const splitHostAndPort = (hostAndPort) => {
  if (hostAndPort.startsWith('[')) {
    const closingBracket = hostAndPort.indexOf(']');
    if (closingBracket === -1) return null;

    const host = hostAndPort.slice(0, closingBracket + 1);
    const remainder = hostAndPort.slice(closingBracket + 1);
    if (remainder && (!remainder.startsWith(':') || !isValidPort(remainder.slice(1)))) {
      return null;
    }

    return { host, port: remainder ? remainder.slice(1) : '' };
  }

  const separator = hostAndPort.indexOf(':');
  if (separator === -1) return { host: hostAndPort, port: '' };
  if (hostAndPort.indexOf(':', separator + 1) !== -1) return null;

  const host = hostAndPort.slice(0, separator);
  const port = hostAndPort.slice(separator + 1);
  if (!isValidPort(port)) return null;
  return { host, port };
};

const isLoopbackHost = (host) => {
  const normalized = host.toLowerCase();
  if (normalized === 'localhost' || normalized === '[::1]') return true;
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized)) return false;

  const octets = normalized.split('.');
  if (octets.some((octet) => String(Number(octet)) !== octet || Number(octet) > 255)) {
    return false;
  }

  return Number(octets[0]) === 127;
};

const isSafeSeedMongoUri = (uri, nodeEnv = process.env.NODE_ENV) => {
  if (String(nodeEnv || '').trim().toLowerCase() === 'production') return false;
  if (typeof uri !== 'string' || !uri || uri !== uri.trim()) return false;
  if (!uri.startsWith(MONGODB_SCHEME) || /\s/.test(uri) || !hasValidPercentEncoding(uri)) {
    return false;
  }

  const authorityEnd = uri.slice(MONGODB_SCHEME.length).search(/[/?#]/);
  const authority = authorityEnd === -1
    ? uri.slice(MONGODB_SCHEME.length)
    : uri.slice(MONGODB_SCHEME.length, MONGODB_SCHEME.length + authorityEnd);

  const firstAt = authority.indexOf('@');
  const lastAt = authority.lastIndexOf('@');
  if (firstAt !== lastAt) return false;

  const hostAndPort = authority.slice(lastAt + 1);
  if (!hostAndPort || hostAndPort.includes(',')) return false;

  const target = splitHostAndPort(hostAndPort);
  if (!target || !isLoopbackHost(target.host)) return false;

  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'mongodb:' || parsed.hash) return false;
    return parsed.hostname.toLowerCase() === target.host.toLowerCase();
  } catch {
    return false;
  }
};

module.exports = {
  isSafeSeedMongoUri,
};
