const jwt = require('jsonwebtoken');

/**
 * JWT middleware — reads from httpOnly cookie or Authorization header.
 * Attaches decoded payload to req.faculty.
 */
const verifyToken = (req, res, next) => {
  const token =
    req.cookies?.token ||
    (req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.split(' ')[1]
      : null);

  if (!token) {
    return res.status(401).json({ error: 'Not authenticated. Please log in.' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.faculty = decoded; // { id, email, employeeId, iat, exp }
    next();
  } catch {
    return res.status(401).json({ error: 'Token invalid or expired. Please log in again.' });
  }
};

module.exports = verifyToken;
