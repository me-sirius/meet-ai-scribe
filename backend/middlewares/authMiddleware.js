const jwt = require("jsonwebtoken");

const { findUserById, toPublicUser } = require("../services/userStore");

const JWT_SECRET = process.env.JWT_SECRET || "meet-ai-scribe-dev-secret";

const getBearerToken = (authHeader) => {
    if (!authHeader || typeof authHeader !== "string") {
        return "";
    }

    const [scheme, token] = authHeader.split(" ");
    if (!/^Bearer$/i.test(scheme || "") || !token) {
        return "";
    }

    return token.trim();
};

const requireAuth = async (req, res, next) => {
    const token = getBearerToken(req.headers.authorization);

    if (!token) {
        return res.status(401).json({
            message: "Authorization token missing. Please sign in.",
        });
    }

    try {
        const payload = jwt.verify(token, JWT_SECRET);

        if (!payload?.sub) {
            return res.status(401).json({
                message: "Invalid token payload.",
            });
        }

        const user = await findUserById(payload.sub);

        if (!user) {
            return res.status(401).json({
                message: "User not found for this token.",
            });
        }

        req.user = toPublicUser(user);
        return next();
    } catch {
        return res.status(401).json({
            message: "Invalid or expired token. Please sign in again.",
        });
    }
};

module.exports = {
    requireAuth,
};
