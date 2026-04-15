const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const {
    createUser,
    findUserByEmail,
    normalizeEmail,
    toPublicUser,
} = require("../services/userStore");
const { requireAuth } = require("../middlewares/authMiddleware");

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || "meet-ai-scribe-dev-secret";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";

const isValidEmail = (email) => {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
};

const sanitizeName = (name) => String(name || "").trim().replace(/\s+/g, " ");

const buildAuthResponse = (user) => {
    const safeUser = toPublicUser(user);
    const token = jwt.sign(
        {
            sub: safeUser.id,
            email: safeUser.email,
            name: safeUser.name,
        },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN },
    );

    return {
        token,
        user: safeUser,
    };
};

router.post("/auth/signup", async (req, res) => {
    const name = sanitizeName(req.body?.name);
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || "");

    if (!name || name.length < 2 || name.length > 60) {
        return res.status(400).json({
            message: "Name must be between 2 and 60 characters.",
        });
    }

    if (!isValidEmail(email)) {
        return res.status(400).json({
            message: "Please provide a valid email address.",
        });
    }

    if (password.length < 6) {
        return res.status(400).json({
            message: "Password must be at least 6 characters.",
        });
    }

    try {
        const existingUser = await findUserByEmail(email);
        if (existingUser) {
            return res.status(409).json({
                message: "An account with this email already exists.",
            });
        }

        const passwordHash = await bcrypt.hash(password, 10);
        const createdUser = await createUser({
            name,
            email,
            passwordHash,
        });

        return res.status(201).json(buildAuthResponse(createdUser));
    } catch (error) {
        const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
        const message = statusCode >= 500
            ? "Failed to create account. Please try again."
            : (error?.message || "Failed to create account.");

        return res.status(statusCode).json({
            message,
        });
    }
});

router.post("/auth/login", async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || "");

    if (!isValidEmail(email)) {
        return res.status(400).json({
            message: "Please provide a valid email address.",
        });
    }

    if (!password) {
        return res.status(400).json({
            message: "Password is required.",
        });
    }

    try {
        const user = await findUserByEmail(email);

        if (!user) {
            return res.status(401).json({
                message: "Invalid email or password.",
            });
        }

        const isPasswordValid = await bcrypt.compare(password, user.passwordHash);

        if (!isPasswordValid) {
            return res.status(401).json({
                message: "Invalid email or password.",
            });
        }

        return res.json(buildAuthResponse(user));
    } catch {
        return res.status(500).json({
            message: "Failed to sign in.",
        });
    }
});

router.get("/auth/me", requireAuth, (req, res) => {
    return res.json({
        user: req.user,
    });
});

module.exports = router;
