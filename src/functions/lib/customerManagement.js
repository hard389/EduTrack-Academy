"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.trackNewCustomerAuth = exports.selfRegisterCustomer = exports.adminArchiveCustomerGroup = exports.adminAssignCustomerGroup = exports.adminSetCustomerDisabled = exports.adminRejectCustomer = exports.adminApproveCustomer = exports.adminUpdateCustomer = exports.adminCreateCustomer = exports.adminSaveCustomerGroup = exports.adminListCustomers = exports.adminSyncRegistrations = exports.adminGetContext = void 0;
const functionsV1 = __importStar(require("firebase-functions/v1"));
const https_1 = require("firebase-functions/v2/https");
const app_1 = require("firebase-admin/app");
const auth_1 = require("firebase-admin/auth");
const firestore_1 = require("firebase-admin/firestore");
if (!(0, app_1.getApps)().length)
    (0, app_1.initializeApp)();
const db = (0, firestore_1.getFirestore)();
const auth = (0, auth_1.getAuth)();
const REGION = "us-central1";
const USERS = "users";
const ADMINS = "admins";
const GROUPS = "customerGroups";
const CUSTOMERS = "customers";
const MAX_GROUPS_PER_ADMIN = 450;
const clean = (value) => typeof value === "string" ? value.trim() : "";
const emailKey = (value) => clean(value).toLowerCase();
const normalizeGroupName = (value) => value.trim().replace(/\s+/g, " ").toLowerCase();
const isAdminProfile = (data) => data.customerManagementAdmin === true ||
    ["admin", "administrator", "superadmin", "super_admin"].includes(clean(data.role).toLowerCase());
const validEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
function fail(code, message) {
    throw new https_1.HttpsError(code, message);
}
function requiredString(value, label, maxLength) {
    const result = clean(value);
    if (!result)
        fail("invalid-argument", `${label} is required.`);
    if (result.length > maxLength) {
        fail("invalid-argument", `${label} must be ${maxLength} characters or fewer.`);
    }
    return result;
}
function optionalString(value, label, maxLength) {
    const result = clean(value);
    if (result.length > maxLength) {
        fail("invalid-argument", `${label} must be ${maxLength} characters or fewer.`);
    }
    return result;
}
function profileDisplayName(data, user) {
    return (clean(data?.teacherName) ||
        clean(data?.name) ||
        clean(data?.displayName) ||
        clean(user?.displayName) ||
        "");
}
/**
 * Find the EXISTING teacher profile.
 * UID is the identity; the email-keyed document ID is a legacy lookup only.
 * This helper never creates or overwrites a profile.
 */
async function findProfile(user) {
    const users = db.collection(USERS);
    const email = emailKey(user.email);
    const uid = user.uid;
    const directUid = await users.doc(uid).get();
    if (directUid.exists) {
        const data = directUid.data() ?? {};
        if (!data.uid || data.uid === uid) {
            return { ref: directUid.ref, data };
        }
    }
    const uidQuery = await users.where("uid", "==", uid).limit(1).get();
    if (!uidQuery.empty) {
        const doc = uidQuery.docs[0];
        return { ref: doc.ref, data: doc.data() };
    }
    if (email) {
        const directEmail = await users.doc(email).get();
        if (directEmail.exists) {
            const data = directEmail.data() ?? {};
            if (!data.uid || data.uid === uid) {
                return { ref: directEmail.ref, data };
            }
        }
        const emailQuery = await users.where("email", "==", email).limit(10).get();
        const matching = emailQuery.docs.find((doc) => {
            const data = doc.data();
            return !data.uid || data.uid === uid;
        });
        if (matching) {
            return { ref: matching.ref, data: matching.data() };
        }
    }
    return null;
}
/**
 * Callable functions trust the verified token's custom claim, not a role
 * field submitted by the browser.
 *
 * The admin's profile must already exist under users/. No duplicate admin
 * teacher profile is created by this function.
 */
async function requireAdmin(request) {
    const token = request.auth?.token;
    if (!request.auth || !token) {
        fail("unauthenticated", "Sign in before managing customers.");
    }
    if (token.admin !== true && clean(token.role).toLowerCase() !== "admin") {
        fail("permission-denied", "Verified administrator access is required.");
    }
    const uid = request.auth.uid;
    const email = emailKey(token.email);
    if (!email) {
        fail("failed-precondition", "The administrator account needs a verified email identity.");
    }
    let user;
    try {
        user = await auth.getUser(uid);
    }
    catch {
        fail("unauthenticated", "The Firebase Authentication account could not be resolved.");
    }
    // Prefer the profile that already matches the Auth UID.
    const profile = await findProfile({
        uid,
        email: user.email ?? email,
    });
    if (!profile) {
        fail("failed-precondition", "The administrator's existing users profile was not found. No duplicate profile was created.");
    }
    // Admin root uses normalized email as its document ID.
    const root = db.collection(ADMINS).doc(email);
    const rootSnapshot = await root.get();
    if (rootSnapshot.exists &&
        clean(rootSnapshot.data()?.adminUid) !== uid) {
        fail("failed-precondition", "This administrator email is already mapped to a different UID.");
    }
    await root.set({
        adminUid: uid,
        email,
        adminProfileDocId: profile.ref.id,
        managementSchemaVersion: 1,
        createdAt: rootSnapshot.exists
            ? rootSnapshot.data()?.createdAt ?? firestore_1.FieldValue.serverTimestamp()
            : firestore_1.FieldValue.serverTimestamp(),
        updatedAt: firestore_1.FieldValue.serverTimestamp(),
    }, { merge: true });
    return { uid, email, profile, root };
}
/** Do not allow another admin to be treated as a customer. */
async function assertNotAnotherAdmin(user) {
    if (user.customClaims?.admin === true) {
        fail("permission-denied", "Administrator accounts cannot be managed as customers.");
    }
    const roots = await db.collection(ADMINS)
        .where("adminUid", "==", user.uid)
        .limit(1)
        .get();
    if (!roots.empty) {
        fail("permission-denied", "Administrator accounts cannot be managed as customers.");
    }
}
/**
 * Minimal profile creation is allowed only when no profile for this UID or
 * email exists. Existing teacher profiles and academic subcollections are
 * never overwritten.
 */
async function getOrCreateTeacherProfile(user) {
    const existing = await findProfile(user);
    if (existing) {
        if (isAdminProfile(existing.data)) {
            fail("permission-denied", "An administrator profile cannot be managed as a customer.");
        }
        return existing;
    }
    const email = emailKey(user.email);
    if (!email) {
        fail("failed-precondition", "This account has no email address.");
    }
    const ref = db.collection(USERS).doc(email);
    const current = await ref.get();
    if (current.exists) {
        const data = current.data() ?? {};
        if (data.uid && data.uid !== user.uid) {
            fail("already-exists", "A profile with this email belongs to another UID. Resolve that legacy mapping first.");
        }
        if (isAdminProfile(data)) {
            fail("permission-denied", "An administrator profile cannot be managed as a customer.");
        }
        return { ref, data };
    }
    const data = {
        uid: user.uid,
        email,
        teacherName: clean(user.displayName),
        name: clean(user.displayName),
        role: "teacher",
        active: !user.disabled,
        disabled: user.disabled,
        registrationSource: "legacy",
        approvalStatus: "legacy",
        emailVerified: user.emailVerified,
        createdAt: user.metadata.creationTime
            ? new Date(user.metadata.creationTime)
            : firestore_1.FieldValue.serverTimestamp(),
        updatedAt: firestore_1.FieldValue.serverTimestamp(),
    };
    await ref.create(data);
    return { ref, data };
}
async function loadCustomer(ctx, customerUidValue) {
    const uid = requiredString(customerUidValue, "Customer UID", 128);
    let user;
    try {
        user = await auth.getUser(uid);
    }
    catch {
        fail("not-found", "Firebase Authentication customer account was not found.");
    }
    await assertNotAnotherAdmin(user);
    const profile = await getOrCreateTeacherProfile(user);
    const registry = ctx.root.collection(CUSTOMERS).doc(user.uid);
    const registrySnapshot = await registry.get();
    let data = registrySnapshot.data() ?? {};
    // Safe, idempotent backfill for a genuine existing account.
    if (!registrySnapshot.exists) {
        data = {
            uid: user.uid,
            email: emailKey(user.email),
            name: profileDisplayName(profile.data, user),
            phone: clean(profile.data.phone) || clean(profile.data.phoneNumber),
            whatsapp: clean(profile.data.whatsappNumber) || clean(profile.data.whatsapp),
            registrationSource: clean(profile.data.registrationSource) || "legacy",
            approvalStatus: clean(profile.data.approvalStatus) || "legacy",
            groupId: clean(profile.data.groupId) || null,
            groupName: clean(profile.data.groupName) || null,
            active: !user.disabled && profile.data.active !== false,
            disabled: user.disabled,
            emailVerified: user.emailVerified,
            profileDocId: profile.ref.id,
            createdAt: profile.data.createdAt ??
                (user.metadata.creationTime ? new Date(user.metadata.creationTime) : null),
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        };
        await registry.set(data, { merge: true });
    }
    return { user, profile, registry, data };
}
async function getActiveGroup(ctx, groupIdValue) {
    const groupId = requiredString(groupIdValue, "Customer group", 128);
    const ref = ctx.root.collection(GROUPS).doc(groupId);
    const snapshot = await ref.get();
    if (!snapshot.exists) {
        fail("not-found", "The selected customer group does not exist.");
    }
    const data = snapshot.data() ?? {};
    if (data.archived === true || data.active === false) {
        fail("failed-precondition", "The selected group is archived or inactive.");
    }
    return { ref, id: groupId, data };
}
/**
 * Keeps registry, existing profile and group memberships synchronized.
 * All Firestore changes in a group move are committed in one transaction.
 */
async function setGroupMembership(ctx, customer, groupIdValue, registryPatch = {}, profilePatch = {}) {
    const groupsRef = ctx.root.collection(GROUPS);
    const target = groupIdValue
        ? await getActiveGroup(ctx, groupIdValue)
        : null;
    await db.runTransaction(async (transaction) => {
        const [groupsSnapshot, registrySnapshot, profileSnapshot] = await Promise.all([
            transaction.get(groupsRef),
            transaction.get(customer.registry),
            transaction.get(customer.profile.ref),
        ]);
        if (groupsSnapshot.size > MAX_GROUPS_PER_ADMIN) {
            fail("resource-exhausted", "There are too many groups to safely update memberships in one operation.");
        }
        if (target) {
            const targetSnapshot = groupsSnapshot.docs.find((doc) => doc.id === target.id);
            if (!targetSnapshot || targetSnapshot.data().archived === true) {
                fail("failed-precondition", "The selected group is no longer active.");
            }
        }
        const name = clean(registrySnapshot.data()?.name) ||
            profileDisplayName(customer.profile.data, customer.user);
        for (const groupDoc of groupsSnapshot.docs) {
            if (target && groupDoc.id === target.id)
                continue;
            transaction.delete(groupDoc.ref.collection(CUSTOMERS).doc(customer.user.uid));
        }
        const effectiveDisabled = typeof registryPatch.disabled === "boolean"
            ? registryPatch.disabled
            : customer.user.disabled;
        const membershipStatus = registryPatch.approvalStatus === "pending"
            ? "pending"
            : registryPatch.approvalStatus === "rejected"
                ? "rejected"
                : effectiveDisabled
                    ? "disabled"
                    : "active";
        if (target) {
            transaction.set(target.ref.collection(CUSTOMERS).doc(customer.user.uid), {
                uid: customer.user.uid,
                customerUid: customer.user.uid,
                email: emailKey(customer.user.email),
                name,
                groupId: target.id,
                membershipStatus,
                status: membershipStatus,
                updatedAt: firestore_1.FieldValue.serverTimestamp(),
                createdAt: firestore_1.FieldValue.serverTimestamp(),
            }, { merge: true });
        }
        transaction.set(customer.registry, {
            uid: customer.user.uid,
            email: emailKey(customer.user.email),
            name,
            profileDocId: customer.profile.ref.id,
            groupId: target?.id ?? null,
            groupName: target ? clean(target.data.name) : null,
            ...registryPatch,
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        }, { merge: true });
        if (profileSnapshot.exists) {
            transaction.set(customer.profile.ref, {
                ...profilePatch,
                groupId: target?.id ?? null,
                groupName: target ? clean(target.data.name) : null,
                updatedAt: firestore_1.FieldValue.serverTimestamp(),
            }, { merge: true });
        }
    });
}
async function pageAllAuthUsers() {
    const result = [];
    let pageToken;
    do {
        const page = await auth.listUsers(1000, pageToken);
        result.push(...page.users);
        pageToken = page.pageToken;
    } while (pageToken);
    return result;
}
/**
 * Real, deduplicated academic counts for a teacher workspace.
 * If a read fails, the unknown value is null rather than a false zero.
 */
async function academicCounts(profile) {
    if (!profile)
        return { classCount: null, studentCount: null };
    try {
        const classes = await profile.ref.collection("classes").get();
        const studentIdentities = new Set();
        for (const classDoc of classes.docs) {
            const students = await classDoc.ref.collection("students").get();
            for (const studentDoc of students.docs) {
                const student = studentDoc.data();
                const identity = clean(student.uid) ||
                    clean(student.studentUid) ||
                    clean(student.studentId) ||
                    clean(student.id) ||
                    clean(student.rollNo) ||
                    studentDoc.id;
                studentIdentities.add(identity);
            }
        }
        return {
            classCount: classes.size,
            studentCount: studentIdentities.size,
        };
    }
    catch {
        return { classCount: null, studentCount: null };
    }
}
/**
 * Returns the normalized admin email which the frontend uses for:
 * admins/{adminEmail}/customerGroups and admins/{adminEmail}/customers.
 */
exports.adminGetContext = (0, https_1.onCall)({ region: REGION }, async (request) => {
    const ctx = await requireAdmin(request);
    return {
        adminDocId: ctx.email,
        adminEmail: ctx.email,
        adminUid: ctx.uid,
        profileDocId: ctx.profile.ref.id,
    };
});
/**
 * Backfills real Firebase Auth users into this admin's registry.
 * It never overwrites an existing approval decision, source label or UID.
 */
exports.adminSyncRegistrations = (0, https_1.onCall)({ region: REGION, timeoutSeconds: 540 }, async (request) => {
    const ctx = await requireAdmin(request);
    const users = await pageAllAuthUsers();
    for (const user of users) {
        if (user.uid === ctx.uid || user.customClaims?.admin === true)
            continue;
        const profile = await findProfile(user);
        if (profile && isAdminProfile(profile.data))
            continue;
        const registry = ctx.root.collection(CUSTOMERS).doc(user.uid);
        const previous = await registry.get();
        const old = previous.data() ?? {};
        const email = emailKey(user.email);
        const profileData = profile?.data ?? {};
        const source = clean(old.registrationSource) ||
            clean(profileData.registrationSource) ||
            "legacy";
        const approvalStatus = clean(old.approvalStatus) ||
            clean(profileData.approvalStatus) ||
            (source === "self_registered" ? "pending" : "legacy");
        const counts = await academicCounts(profile);
        const groupId = clean(old.groupId) || clean(profileData.groupId) || null;
        let groupName = clean(old.groupName) || clean(profileData.groupName) || "";
        if (groupId) {
            const groupSnapshot = await ctx.root.collection(GROUPS).doc(groupId).get();
            groupName = clean(groupSnapshot.data()?.name) || groupName;
        }
        const disabled = user.disabled;
        const active = !disabled &&
            profileData.active !== false &&
            approvalStatus !== "pending" &&
            approvalStatus !== "rejected";
        await registry.set({
            uid: user.uid,
            email,
            name: clean(old.name) ||
                profileDisplayName(profileData, user) ||
                email,
            phone: clean(old.phone) ||
                clean(profileData.phone) ||
                clean(profileData.phoneNumber),
            whatsapp: clean(old.whatsapp) ||
                clean(profileData.whatsappNumber) ||
                clean(profileData.whatsapp),
            profileDocId: profile?.ref.id ?? null,
            role: clean(profileData.role) || "teacher",
            registrationSource: source,
            approvalStatus,
            emailVerified: user.emailVerified,
            disabled,
            active,
            groupId,
            groupName: groupName || null,
            classCount: counts.classCount,
            studentCount: counts.studentCount,
            createdAt: old.createdAt ??
                profileData.createdAt ??
                (user.metadata.creationTime
                    ? new Date(user.metadata.creationTime)
                    : firestore_1.FieldValue.serverTimestamp()),
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        }, { merge: true });
    }
    return { success: true, synchronized: users.length };
});
/** Optional callable list endpoint for diagnostic/manual use. */
exports.adminListCustomers = (0, https_1.onCall)({ region: REGION }, async (request) => {
    const ctx = await requireAdmin(request);
    const [groups, customers] = await Promise.all([
        ctx.root.collection(GROUPS).get(),
        ctx.root.collection(CUSTOMERS).get(),
    ]);
    return {
        groups: groups.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
        customers: customers.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
    };
});
exports.adminSaveCustomerGroup = (0, https_1.onCall)({ region: REGION }, async (request) => {
    const ctx = await requireAdmin(request);
    const input = (request.data ?? {});
    const name = requiredString(input.name, "Group name", 80)
        .replace(/\s+/g, " ");
    const description = optionalString(input.description, "Description", 300);
    const normalizedName = normalizeGroupName(name);
    const groupId = clean(input.groupId);
    const groupsRef = ctx.root.collection(GROUPS);
    const targetRef = groupId ? groupsRef.doc(groupId) : groupsRef.doc();
    await db.runTransaction(async (transaction) => {
        const allGroups = await transaction.get(groupsRef);
        const current = groupId ? await transaction.get(targetRef) : null;
        const duplicate = allGroups.docs.find((doc) => doc.id !== targetRef.id &&
            doc.data().archived !== true &&
            normalizeGroupName(clean(doc.data().name)) === normalizedName);
        if (duplicate) {
            fail("already-exists", `A group named "${name}" already exists.`);
        }
        if (groupId && !current?.exists) {
            fail("not-found", "The customer group could not be found.");
        }
        if (current?.data()?.archived === true) {
            fail("failed-precondition", "An archived group cannot be edited.");
        }
        const prior = current?.data() ?? {};
        transaction.set(targetRef, {
            name,
            normalizedName,
            description,
            active: true,
            archived: false,
            createdByUid: clean(prior.createdByUid) || ctx.uid,
            createdAt: prior.createdAt ?? firestore_1.FieldValue.serverTimestamp(),
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        }, { merge: true });
    });
    return { success: true, groupId: targetRef.id };
});
exports.adminCreateCustomer = (0, https_1.onCall)({ region: REGION, timeoutSeconds: 120 }, async (request) => {
    const ctx = await requireAdmin(request);
    const input = (request.data ?? {});
    const name = requiredString(input.name, "Full name", 120);
    const email = emailKey(requiredString(input.email, "Email", 254));
    const phone = optionalString(input.phone, "Phone", 30);
    const whatsapp = optionalString(input.whatsapp, "WhatsApp", 30);
    if (!validEmail(email)) {
        fail("invalid-argument", "Enter a valid email address.");
    }
    const group = await getActiveGroup(ctx, input.groupId);
    try {
        await auth.getUserByEmail(email);
        fail("already-exists", "A Firebase Authentication account already uses this email.");
    }
    catch (error) {
        if (error instanceof https_1.HttpsError)
            throw error;
        if (!String(error.code ?? "").includes("user-not-found")) {
            throw error;
        }
    }
    // Never overwrite an existing legacy/academic profile.
    const existingById = await db.collection(USERS).doc(email).get();
    const existingByEmail = await db.collection(USERS)
        .where("email", "==", email)
        .limit(10)
        .get();
    if (existingById.exists || !existingByEmail.empty) {
        fail("already-exists", "A Firestore profile already uses this email. Resolve the existing profile instead of creating a duplicate.");
    }
    const createdUser = await auth.createUser({
        email,
        displayName: name,
        emailVerified: false,
        disabled: false,
    });
    const profileRef = db.collection(USERS).doc(email);
    const registryRef = ctx.root.collection(CUSTOMERS).doc(createdUser.uid);
    const membershipRef = group.ref.collection(CUSTOMERS).doc(createdUser.uid);
    try {
        await db.runTransaction(async (transaction) => {
            const [profileSnapshot, registrySnapshot, groupSnapshot] = await Promise.all([
                transaction.get(profileRef),
                transaction.get(registryRef),
                transaction.get(group.ref),
            ]);
            if (profileSnapshot.exists) {
                fail("already-exists", "The profile appeared during creation. No existing profile was overwritten.");
            }
            // Auth onCreate may win the race and write a pending self_registered
            // registry entry. Allow only that trigger-generated entry to be replaced.
            if (registrySnapshot.exists &&
                clean(registrySnapshot.data()?.registrationSource) !== "self_registered") {
                fail("already-exists", "This UID already has a customer registry record.");
            }
            if (!groupSnapshot.exists || groupSnapshot.data()?.archived === true) {
                fail("failed-precondition", "The selected group is no longer available.");
            }
            transaction.create(profileRef, {
                uid: createdUser.uid,
                email,
                teacherName: name,
                name,
                phone,
                whatsappNumber: whatsapp,
                role: "teacher",
                active: true,
                disabled: false,
                emailVerified: false,
                registrationSource: "admin_created",
                approvalStatus: "approved",
                groupId: group.id,
                groupName: clean(groupSnapshot.data()?.name),
                createdByAdminUid: ctx.uid,
                createdAt: firestore_1.FieldValue.serverTimestamp(),
                updatedAt: firestore_1.FieldValue.serverTimestamp(),
            });
            transaction.set(registryRef, {
                uid: createdUser.uid,
                email,
                name,
                phone,
                whatsapp,
                profileDocId: profileRef.id,
                registrationSource: "admin_created",
                approvalStatus: "approved",
                emailVerified: false,
                active: true,
                disabled: false,
                groupId: group.id,
                groupName: clean(groupSnapshot.data()?.name),
                classCount: 0,
                studentCount: 0,
                createdByAdminUid: ctx.uid,
                createdAt: firestore_1.FieldValue.serverTimestamp(),
                updatedAt: firestore_1.FieldValue.serverTimestamp(),
            });
            transaction.set(membershipRef, {
                uid: createdUser.uid,
                customerUid: createdUser.uid,
                email,
                name,
                groupId: group.id,
                membershipStatus: "active",
                status: "active",
                createdAt: firestore_1.FieldValue.serverTimestamp(),
                updatedAt: firestore_1.FieldValue.serverTimestamp(),
            });
        });
    }
    catch (error) {
        // Only delete the Auth account created in this invocation.
        // The transaction has rolled back all its Firestore writes.
        try {
            const registrySnapshot = await registryRef.get();
            if (registrySnapshot.exists &&
                clean(registrySnapshot.data()?.registrationSource) === "self_registered") {
                await registryRef.delete();
            }
            await auth.deleteUser(createdUser.uid);
        }
        catch {
            throw new https_1.HttpsError("failed-precondition", `Setup failed after creating UID ${createdUser.uid}. Do not retry with a new email; reconcile this UID in Firebase first.`);
        }
        throw error;
    }
    // The frontend then requests Firebase's password setup/reset email.
    // This function does not claim that email delivery has already happened.
    return {
        success: true,
        uid: createdUser.uid,
        email,
        setupEmailRequired: true,
    };
});
exports.adminUpdateCustomer = (0, https_1.onCall)({ region: REGION }, async (request) => {
    const ctx = await requireAdmin(request);
    const input = (request.data ?? {});
    const name = requiredString(input.name, "Full name", 120);
    const phone = optionalString(input.phone, "Phone", 30);
    const whatsapp = optionalString(input.whatsapp, "WhatsApp", 30);
    const groupId = input.groupId
        ? requiredString(input.groupId, "Group ID", 128)
        : null;
    const customer = await loadCustomer(ctx, input.customerId);
    await auth.updateUser(customer.user.uid, { displayName: name });
    await setGroupMembership(ctx, customer, groupId, { name, phone, whatsapp, active: !customer.user.disabled }, {
        name,
        teacherName: name,
        phone,
        whatsappNumber: whatsapp,
    });
    return { success: true, uid: customer.user.uid };
});
exports.adminApproveCustomer = (0, https_1.onCall)({ region: REGION }, async (request) => {
    const ctx = await requireAdmin(request);
    const input = (request.data ?? {});
    const customer = await loadCustomer(ctx, input.customerId);
    const approval = clean(customer.data.approvalStatus).toLowerCase();
    if (approval !== "pending") {
        fail("failed-precondition", "Only pending registrations can be approved.");
    }
    if (!customer.user.emailVerified) {
        fail("failed-precondition", "The customer's email must be verified before approval.");
    }
    const group = await getActiveGroup(ctx, input.groupId);
    // Enable the real Firebase Authentication account.
    await auth.updateUser(customer.user.uid, {
        disabled: false,
    });
    // Keep the original UserRecord intact. The disabled override is carried
    // through registryPatch so membershipStatus becomes "active".
    await setGroupMembership(ctx, customer, group.id, {
        approvalStatus: "approved",
        active: true,
        disabled: false,
        emailVerified: true,
        reviewedBy: ctx.uid,
        reviewedAt: firestore_1.FieldValue.serverTimestamp(),
    }, {
        approvalStatus: "approved",
        active: true,
        disabled: false,
        emailVerified: true,
    });
    return {
        success: true,
        uid: customer.user.uid,
        groupId: group.id,
    };
});
exports.adminRejectCustomer = (0, https_1.onCall)({ region: REGION }, async (request) => {
    const ctx = await requireAdmin(request);
    const input = (request.data ?? {});
    const customer = await loadCustomer(ctx, input.customerId);
    if (clean(customer.data.approvalStatus).toLowerCase() !== "pending") {
        fail("failed-precondition", "Only pending registrations can be rejected.");
    }
    await setGroupMembership(ctx, customer, null, {
        approvalStatus: "rejected",
        active: false,
        groupId: null,
        groupName: null,
        rejectedBy: ctx.uid,
        rejectedAt: firestore_1.FieldValue.serverTimestamp(),
    }, {
        approvalStatus: "rejected",
        active: false,
        groupId: null,
        groupName: null,
    });
    // Rejection does not delete or disable the Auth account or its workspace.
    return { success: true, uid: customer.user.uid };
});
exports.adminSetCustomerDisabled = (0, https_1.onCall)({ region: REGION }, async (request) => {
    const ctx = await requireAdmin(request);
    const input = (request.data ?? {});
    if (typeof input.disabled !== "boolean") {
        fail("invalid-argument", "The disabled field must be true or false.");
    }
    const customer = await loadCustomer(ctx, input.customerId);
    const approval = clean(customer.data.approvalStatus).toLowerCase();
    if (input.disabled === false &&
        (approval === "pending" || approval === "rejected")) {
        fail("failed-precondition", "A pending or rejected registration cannot be enabled.");
    }
    await auth.updateUser(customer.user.uid, { disabled: input.disabled });
    if (input.disabled) {
        await auth.revokeRefreshTokens(customer.user.uid);
    }
    const batch = db.batch();
    const active = input.disabled === false &&
        approval !== "pending" &&
        approval !== "rejected";
    batch.set(customer.registry, {
        disabled: input.disabled,
        active,
        updatedAt: firestore_1.FieldValue.serverTimestamp(),
    }, { merge: true });
    batch.set(customer.profile.ref, {
        disabled: input.disabled,
        active,
        updatedAt: firestore_1.FieldValue.serverTimestamp(),
    }, { merge: true });
    const currentGroupId = clean(customer.data.groupId);
    if (currentGroupId) {
        batch.set(ctx.root.collection(GROUPS).doc(currentGroupId)
            .collection(CUSTOMERS).doc(customer.user.uid), {
            membershipStatus: input.disabled ? "disabled" : "active",
            status: input.disabled ? "disabled" : "active",
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        }, { merge: true });
    }
    await batch.commit();
    return { success: true, uid: customer.user.uid, disabled: input.disabled };
});
exports.adminAssignCustomerGroup = (0, https_1.onCall)({ region: REGION }, async (request) => {
    const ctx = await requireAdmin(request);
    const input = (request.data ?? {});
    const customer = await loadCustomer(ctx, input.customerId);
    const groupId = input.groupId
        ? requiredString(input.groupId, "Group ID", 128)
        : null;
    await setGroupMembership(ctx, customer, groupId);
    return { success: true, uid: customer.user.uid, groupId };
});
exports.adminArchiveCustomerGroup = (0, https_1.onCall)({ region: REGION }, async (request) => {
    const ctx = await requireAdmin(request);
    const input = (request.data ?? {});
    const groupId = requiredString(input.groupId, "Group ID", 128);
    const groupRef = ctx.root.collection(GROUPS).doc(groupId);
    const registryQuery = ctx.root.collection(CUSTOMERS)
        .where("groupId", "==", groupId);
    await db.runTransaction(async (transaction) => {
        const [groupSnapshot, members, assigned] = await Promise.all([
            transaction.get(groupRef),
            transaction.get(groupRef.collection(CUSTOMERS)),
            transaction.get(registryQuery),
        ]);
        if (!groupSnapshot.exists)
            fail("not-found", "Customer group was not found.");
        if (!members.empty ||
            !assigned.empty) {
            fail("failed-precondition", "Reassign or unassign the group's customers before archiving it.");
        }
        transaction.set(groupRef, {
            archived: true,
            active: false,
            archivedByUid: ctx.uid,
            archivedAt: firestore_1.FieldValue.serverTimestamp(),
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        }, { merge: true });
    });
    return { success: true, groupId, archived: true };
});
/**
 * Public signup calls this after Firebase Authentication creates the account.
 * Only the caller's own token UID and email are used.
 */
exports.selfRegisterCustomer = (0, https_1.onCall)({ region: REGION }, async (request) => {
    if (!request.auth) {
        fail("unauthenticated", "Sign in to complete registration.");
    }
    const callerUid = request.auth.uid;
    const token = request.auth.token;
    const email = emailKey(token.email);
    if (!email || !validEmail(email)) {
        fail("failed-precondition", "The signed-in account needs a valid email.");
    }
    const input = (request.data ?? {});
    const name = requiredString(input.name, "Full name", 120);
    const phone = optionalString(input.phone, "Phone", 30);
    const whatsapp = optionalString(input.whatsapp, "WhatsApp", 30);
    const user = await auth.getUser(callerUid);
    if (user.customClaims?.admin === true) {
        fail("permission-denied", "Administrator accounts cannot use customer signup.");
    }
    // Resolve by UID first. New email-keyed profiles are created only if absent.
    let profile = await findProfile(user);
    if (!profile) {
        const profileRef = db.collection(USERS).doc(email);
        const current = await profileRef.get();
        if (current.exists) {
            const prior = current.data() ?? {};
            if (prior.uid && prior.uid !== callerUid) {
                fail("already-exists", "A profile already uses this email and belongs to another UID.");
            }
            profile = { ref: profileRef, data: prior };
        }
        else {
            const profileData = {
                uid: callerUid,
                email,
                teacherName: name,
                name,
                phone,
                whatsappNumber: whatsapp,
                role: "teacher",
                active: false,
                disabled: false,
                emailVerified: user.emailVerified,
                registrationSource: "self_registered",
                approvalStatus: "pending",
                createdAt: firestore_1.FieldValue.serverTimestamp(),
                updatedAt: firestore_1.FieldValue.serverTimestamp(),
            };
            await profileRef.create(profileData);
            profile = { ref: profileRef, data: profileData };
        }
    }
    if (isAdminProfile(profile.data)) {
        fail("permission-denied", "Administrator profiles cannot register as customers.");
    }
    await profile.ref.set({
        uid: callerUid,
        email,
        teacherName: name,
        name,
        phone,
        whatsappNumber: whatsapp,
        registrationSource: "self_registered",
        // Never let a repeated registration call reverse an existing decision.
        updatedAt: firestore_1.FieldValue.serverTimestamp(),
    }, { merge: true });
    const roots = await db.collection(ADMINS).get();
    for (const rootDoc of roots.docs) {
        if (clean(rootDoc.data().adminUid) === callerUid)
            continue;
        const registry = rootDoc.ref.collection(CUSTOMERS).doc(callerUid);
        await db.runTransaction(async (transaction) => {
            const snapshot = await transaction.get(registry);
            const old = snapshot.data() ?? {};
            if (snapshot.exists &&
                clean(old.registrationSource) !== "self_registered") {
                return;
            }
            transaction.set(registry, {
                uid: callerUid,
                email,
                name,
                phone,
                whatsapp,
                profileDocId: profile.ref.id,
                registrationSource: "self_registered",
                approvalStatus: clean(old.approvalStatus) || "pending",
                active: false,
                disabled: user.disabled,
                emailVerified: user.emailVerified,
                groupId: old.groupId ?? null,
                createdAt: old.createdAt ?? firestore_1.FieldValue.serverTimestamp(),
                updatedAt: firestore_1.FieldValue.serverTimestamp(),
            }, { merge: true });
        });
    }
    return {
        success: true,
        uid: callerUid,
        email,
        approvalStatus: clean(profile.data.approvalStatus) || "pending",
    };
});
/**
 * Authentication trigger: captures accounts created by other signup flows.
 * The callable sync action also backfills accounts created before this trigger.
 */
exports.trackNewCustomerAuth = functionsV1
    .region(REGION)
    .auth.user()
    .onCreate(async (user) => {
    if (user.customClaims?.admin === true)
        return;
    const roots = await db.collection(ADMINS).get();
    const email = emailKey(user.email);
    await Promise.all(roots.docs.map(async (rootDoc) => {
        if (clean(rootDoc.data().adminUid) === user.uid)
            return;
        const registry = rootDoc.ref.collection(CUSTOMERS).doc(user.uid);
        await db.runTransaction(async (transaction) => {
            const snapshot = await transaction.get(registry);
            if (snapshot.exists)
                return;
            transaction.create(registry, {
                uid: user.uid,
                email,
                name: clean(user.displayName),
                phone: clean(user.phoneNumber),
                whatsapp: "",
                registrationSource: "self_registered",
                approvalStatus: "pending",
                active: false,
                disabled: Boolean(user.disabled),
                emailVerified: Boolean(user.emailVerified),
                groupId: null,
                groupName: null,
                createdAt: user.metadata.creationTime
                    ? new Date(user.metadata.creationTime)
                    : firestore_1.FieldValue.serverTimestamp(),
                updatedAt: firestore_1.FieldValue.serverTimestamp(),
            });
        });
    }));
});
//# sourceMappingURL=customerManagement.js.map