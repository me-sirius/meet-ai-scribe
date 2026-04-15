const prisma = require("./prisma");

const normalizeEmail = (email) => String(email || "").trim().toLowerCase();

const normalizeName = (name) => String(name || "").trim().replace(/\s+/g, " ");

const toPublicUser = (user) => ({
    id: user.id,
    name: user.name,
    email: user.email,
    createdAt: user.createdAt,
});

const findUserByEmail = async (email) => {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) {
        return null;
    }

    return prisma.user.findUnique({
        where: {
            email: normalizedEmail,
        },
    });
};

const findUserById = async (id) => {
    const normalizedId = String(id || "").trim();

    if (!normalizedId) {
        return null;
    }

    return prisma.user.findUnique({
        where: {
            id: normalizedId,
        },
    });
};

const createUser = async ({ name, email, passwordHash }) => {
    const normalizedEmail = normalizeEmail(email);

    try {
        return await prisma.user.create({
            data: {
                name: normalizeName(name),
                email: normalizedEmail,
                passwordHash,
            },
        });
    } catch (error) {
        if (error?.code === "P2002") {
            const err = new Error("An account with this email already exists.");
            err.statusCode = 409;
            throw err;
        }

        throw error;
    }
};

module.exports = {
    normalizeEmail,
    toPublicUser,
    findUserByEmail,
    findUserById,
    createUser,
};
