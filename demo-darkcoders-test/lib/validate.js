const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISBN_PATTERN = /^\d{13}$/;

function isMissing(value) {
  return value === undefined || value === null;
}

function isJsonObject(body) {
  return body !== null && typeof body === "object" && !Array.isArray(body);
}

function requireString(body, field, { minLength = 1, pattern, label } = {}) {
  if (!isJsonObject(body) || isMissing(body[field]) || typeof body[field] !== "string") {
    return `${field} must be a string`;
  }

  if (body[field].length < minLength) {
    return `${label || field} must be at least ${minLength} character${minLength === 1 ? "" : "s"}`;
  }

  if (pattern && !pattern.test(body[field])) {
    return `${label || field} is invalid`;
  }

  return null;
}

module.exports = {
  EMAIL_PATTERN,
  ISBN_PATTERN,
  isMissing,
  isJsonObject,
  requireString,
};
