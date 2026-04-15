require("dotenv").config();

const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const prisma = require("../services/prisma");

const USERS_FILE_PATH = path.join(__dirname, "..", "data", "users.json");

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const normalizeEmail = (email) => String(email || "").trim().toLowerCase();
const normalizeName = (name) => String(name || "").trim().replace(/\s+/g, " ");

const toDate = (value, fallback) => {
    const parsed = new Date(value || fallback);
    return Number.isFinite(parsed.getTime()) ? parsed : new Date(fallback);
};

const isValidUuid = (value) => UUID_REGEX.test(String(value || "").trim());

const loadUsersFromJson = async () => {
    const raw = await fs.readFile(USERS_FILE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
};

const importUsers = async () => {
    const users = await loadUsersFromJson();

    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const user of users) {
        const email = normalizeEmail(user?.email);
        const name = normalizeName(user?.name);
        const passwordHash = String(user?.passwordHash || "").trim();

        if (!EMAIL_REGEX.test(email) || !name || !passwordHash) {
            skipped += 1;
            continue;
        }

        const id = isValidUuid(user?.id)
            ? String(user.id).trim()
            : crypto.randomUUID();

        const createdAt = toDate(user?.createdAt, Date.now());
        const updatedAt = toDate(user?.updatedAt, createdAt);

        const existing = await prisma.user.findUnique({ where: { email } });

        if (existing) {
            await prisma.user.update({
                where: { id: existing.id },
                data: {
                    name,
                    passwordHash,
                    updatedAt,
                },
            });

            updated += 1;
            continue;
        }

        await prisma.user.create({
            data: {
                id,
                name,
                email,
                passwordHash,
                createdAt,
                updatedAt,
            },
        });

        created += 1;
    }

    console.log(`[importUsersToPrisma] created=${created} updated=${updated} skipped=${skipped}`);
};

importUsers()
    .catch((error) => {
        console.error("[importUsersToPrisma] failed", error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
