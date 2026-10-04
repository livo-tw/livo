// Member management (self-hosted edge function).
// Actions: create / toggle_active / delete / reset_password / create_login —
// mirrors worker/src/functions/manageMember.ts.
// Fixes vs. the legacy version:
//   - create accepts an optional body.password (self-hosted stacks ship with
//     OAuth disabled — without a known password a new member could never log
//     in); a random throwaway is used only when none is supplied.
//   - the duplicate-member check runs BEFORE creating the auth user (no orphans).
//   - GoTrue listUsers() is paginated (~50/page by default); every auth-user
//     lookup now prefers members.auth_id and falls back to a FULL paged email
//     scan, so toggle_active/delete no longer silently no-op past 50 users.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.98.0";
import { isPlaceholderEmail, isValidEmail, normalizeEmail } from "./jiraCsv.ts";
import {
  API_KEY_FORBIDDEN,
  deliverLogin,
  discardLogin,
  isApiKeyToken,
  loadAuthUsersByEmail,
  LoginError,
  prepareLogin,
  resolveLoginChannel,
  unusablePassword,
} from "./memberAccounts.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

// Scan ALL listUsers pages for a user with this email (case-insensitive —
// GoTrue stores emails lowercased). Returns null when not found.
async function findAuthUserByEmail(supabaseAdmin: any, email: string): Promise<any | null> {
  const target = (email || "").trim().toLowerCase();
  if (!target) return null;
  const perPage = 1000;
  for (let page = 1; page <= 100; page++) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage });
    if (error) {
      console.error("listUsers error:", error);
      return null;
    }
    const users = data?.users || [];
    const found = users.find((u: any) => (u.email || "").toLowerCase() === target);
    if (found) return found;
    if (users.length < perPage) return null; // last page reached
  }
  return null;
}

// Prefer the direct members.auth_id link; fall back to a full paged email scan.
async function resolveAuthUser(
  supabaseAdmin: any,
  member: { auth_id?: string | null; email?: string | null },
): Promise<any | null> {
  if (member.auth_id) {
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(member.auth_id);
    if (!error && data?.user) return data.user;
  }
  if (member.email) return await findAuthUserByEmail(supabaseAdmin, member.email);
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    // Verify caller is authenticated
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "Unauthorized" }, 401);
    }

    // Verify caller identity via JWT
    const token = authHeader.replace("Bearer ", "");
    const { data: { user: callerAuth }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !callerAuth) {
      return json({ error: "Invalid token" }, 401);
    }

    // Verify caller is an active admin or super_admin linked to this login
    // (keep the role — reset_password has a stricter per-action rule below).
    // No e-mail fallback: a login that is not linked to a member could carry
    // an admin's address (self-registered while public sign-up was open), and
    // a member deactivated less than an hour ago still holds a valid token.
    const { data: callerMember } = await supabaseAdmin
      .from("members")
      .select("role, name")
      .eq("auth_id", callerAuth.id)
      .eq("is_active", true)
      .maybeSingle();

    const callerRole: string | null = callerMember ? callerMember.role : null;
    const callerName: string = callerMember ? callerMember.name : "";
    if (!callerRole || !["admin", "super_admin"].includes(callerRole)) {
      return json({ error: "Permission denied: admin role required" }, 403);
    }

    const { action, ...params } = await req.json();
    // Deactivating or deleting a member removes their login too (ban / delete),
    // so it is a super_admin action, as in the app. An admin could otherwise
    // lock out a super_admin.
    if (callerRole !== 'super_admin' && (action === 'reset_password' || action === 'create_login' || action === 'toggle_active' || action === 'delete')) {
      return json({ error: 'Permission denied: only super_admin can manage another member login' },403);
    }
    if (action === 'create') {
      if (params.qaAdmin !== undefined && typeof params.qaAdmin !== 'boolean') return json({ error: 'invalid QA capability' },400);
      if (params.role && !['member','admin','super_admin'].includes(params.role)) return json({ error: 'invalid role' },400);
      if (params.jobTitle !== undefined && (typeof params.jobTitle !== 'string' || params.jobTitle.length > 200)) return json({ error: 'job_title must be at most 200 characters' },400);
      if (callerRole !== 'super_admin' && ((params.jobTitle || '').trim() || (params.role && params.role !== 'member') || params.qaAdmin === true)) {
        return json({ error: 'Permission denied: only super_admin can assign positions or administrative roles' },403);
      }
    }

    // A login JWT minted from a personal API key may manage members, but never
    // set a password or open a login: a leaked key must not become an account
    // takeover. (create without a password only gets an unusable random one.)
    if (
      isApiKeyToken(token) &&
      (action === "reset_password" ||
        action === "create_login" ||
        (action === "create" && typeof params.password === "string" && params.password.length > 0))
    ) {
      return json(API_KEY_FORBIDDEN, 403);
    }

    if (action === "create") {
      const { email, name, role, jobTitle, avatar, color, password } = params;
      const emailStr = String(email ?? "").trim();
      const nameStr = String(name ?? "");
      if (!emailStr) {
        return json({ error: "email is required" }, 400);
      }

      // Duplicate member check FIRST (avoids orphaning a fresh auth user).
      // Case-insensitive, as GoTrue matches logins: "Boss@x" and "boss@x" are
      // one login, and a second member on it would share that person's account.
      const { data: memberEmails } = await supabaseAdmin
        .from("members")
        .select("email");
      const emailKey = emailStr.toLowerCase();
      if ((memberEmails || []).some((m: { email?: string | null }) => (m.email || "").trim().toLowerCase() === emailKey)) {
        return json({ error: "此 Email 的成員已存在", code: "member_exists" }, 400);
      }

      // Use the admin-supplied password when given; otherwise a random one
      // nobody knows (the member signs in after a reset or an invitation).
      const newPassword =
        typeof password === "string" && password.length > 0
          ? password
          : unusablePassword();

      // Find-or-create the auth user (scan ALL pages, not just the first).
      let authUserId: string;
      let createdAuthUser = false;
      const existingAuth = await findAuthUserByEmail(supabaseAdmin, emailStr);

      if (existingAuth) {
        // A login with this email already exists, e.g. one self-registered
        // while public sign-up was open. Adopt it only when no member uses it,
        // and give it this member's password and lift any ban, as 「啟用帳號」
        // does, so whoever registered it cannot keep signing in with their own.
        const { data: owner } = await supabaseAdmin
          .from("members")
          .select("id")
          .eq("auth_id", existingAuth.id)
          .limit(1);
        if (owner && owner.length > 0) {
          return json({ error: "email_taken", message: "這個 Email 的登入帳號屬於另一位成員" }, 409);
        }
        const { error: adoptErr } = await supabaseAdmin.auth.admin.updateUserById(existingAuth.id, {
          password: newPassword,
          email_confirm: true,
          ban_duration: "none",
        });
        if (adoptErr) {
          return json({ error: adoptErr.message }, 400);
        }
        authUserId = existingAuth.id;
      } else {
        const { data: authUser, error: authCreateErr } =
          await supabaseAdmin.auth.admin.createUser({
            email: emailStr,
            password: newPassword,
            email_confirm: true,
            user_metadata: { full_name: nameStr },
          });

        if (authCreateErr) {
          return json({ error: authCreateErr.message }, 400);
        }
        authUserId = authUser.user.id;
        createdAuthUser = true;
      }

      // Create member row
      const memberId =
        "u" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const { error: memberError } = await supabaseAdmin
        .from("members")
        .insert({
          id: memberId,
          email: emailStr,
          name: nameStr,
          role: role || "member",
          is_qa_admin: (!role || role === "member") && params.qaAdmin === true,
          job_title: jobTitle || "",
          avatar: avatar || nameStr.slice(0, 1).toUpperCase(),
          color: color || "#6B778C",
          is_active: true,
          auth_id: authUserId,
        });

      if (memberError) {
        // Only delete auth user if we created it here (not pre-existing)
        if (createdAuthUser) {
          try {
            await supabaseAdmin.auth.admin.deleteUser(authUserId);
          } catch (_e) {
            // best-effort rollback
          }
        }
        return json({ error: memberError.message }, 400);
      }

      return json({ success: true, memberId });
    }

    if (action === "toggle_active") {
      const { memberId, isActive } = params;

      // Get member email + auth link
      const { data: member } = await supabaseAdmin
        .from("members")
        .select("email, auth_id")
        .eq("id", memberId)
        .maybeSingle();

      if (!member) {
        return json({ error: "Member not found" }, 404);
      }

      // Update member is_active
      const { error } = await supabaseAdmin
        .from("members")
        .update({ is_active: isActive === true })
        .eq("id", memberId);

      if (error) {
        return json({ error: error.message }, 400);
      }

      // Ban/unban auth user (auth_id link first, else full paged email scan)
      const authUser = await resolveAuthUser(supabaseAdmin, member);
      if (authUser) {
        await supabaseAdmin.auth.admin.updateUserById(authUser.id, {
          ban_duration: isActive === true ? "none" : "876000h", // ~100 years
        });
      }

      return json({ success: true });
    }

    if (action === "delete") {
      const { memberId } = params;

      // Get member email + auth link
      const { data: member } = await supabaseAdmin
        .from("members")
        .select("email, auth_id")
        .eq("id", memberId)
        .maybeSingle();

      if (!member) {
        return json({ error: "Member not found" }, 404);
      }

      // Resolve the auth user BEFORE deleting the member row — members.auth_id
      // is the reliable link and the row is about to disappear.
      const authUser = await resolveAuthUser(supabaseAdmin, member);

      // Delete member row
      const { error } = await supabaseAdmin
        .from("members")
        .delete()
        .eq("id", memberId);

      if (error) {
        return json({ error: error.message }, 400);
      }

      // Delete auth user
      if (authUser) {
        await supabaseAdmin.auth.admin.deleteUser(authUser.id);
      }

      return json({ success: true });
    }

    if (action === "reset_password") {
      // Admin sets a member's login password (onboarding / forgot-password on
      // a self-host install with no email service).
      const { memberId, newPassword } = params;
      const memberIdStr = String(memberId ?? "");
      const newPasswordStr = String(newPassword ?? "");
      if (!memberIdStr) {
        return json({ error: "memberId is required" }, 400);
      }
      if (newPasswordStr.length < 8) {
        return json({ error: "password_too_short", message: "密碼至少需要 8 碼" }, 400);
      }

      // Get member email + role + auth link
      const { data: member } = await supabaseAdmin
        .from("members")
        .select("email, role, auth_id")
        .eq("id", memberIdStr)
        .maybeSingle();

      if (!member) {
        return json({ error: "Member not found" }, 404);
      }
      // Imported people carry a placeholder (uN@import.invalid): a password on
      // that address would be a login nobody can use — 「啟用帳號」 sets the email.
      if (isPlaceholderEmail(member.email)) {
        return json(
          { error: "member_has_no_email", message: "此成員還沒有 Email，請先用「啟用帳號」設定" },
          400
        );
      }

      // Escalation rule: only a super_admin may reset an admin's or
      // super_admin's password.
      if (
        ["admin", "super_admin"].includes(member.role || "") &&
        callerRole !== "super_admin"
      ) {
        return json(
          { error: "Permission denied: only super_admin can reset an admin password" },
          403
        );
      }

      // Resolve auth user (auth_id link first, else full paged email scan)
      const authUser = await resolveAuthUser(supabaseAdmin, member);

      if (authUser) {
        // A login found by email and not linked to this member: if another
        // member owns it, leave it alone; otherwise (a self-registered #40-era
        // account) link it below. An unlinked login sees no data since
        // 20261019_active_member_gate.sql, so a reset alone would not let the
        // person in.
        const relink = member.auth_id !== authUser.id;
        if (relink) {
          const { data: owner } = await supabaseAdmin
            .from("members")
            .select("id")
            .eq("auth_id", authUser.id)
            .limit(1);
          if (owner && owner.length > 0) {
            return json(
              { error: "email_taken", message: "這個 Email 的登入帳號屬於另一位成員" },
              409
            );
          }
        }
        // GoTrue invalidates the user's refresh tokens on password update, so
        // whoever held the old credentials is locked out.
        const { error } = await supabaseAdmin.auth.admin.updateUserById(authUser.id, {
          password: newPasswordStr,
        });
        if (error) {
          return json({ error: error.message }, 400);
        }
        if (relink) {
          const { error: linkErr } = await supabaseAdmin
            .from("members")
            .update({ auth_id: authUser.id })
            .eq("id", memberIdStr);
          if (linkErr) {
            return json({ error: linkErr.message }, 400);
          }
        }
      } else {
        // Member never had a login (e.g. imported from Jira) — resetting
        // heals it: create the auth user and link it back to the member row.
        const { data: created, error: createErr } =
          await supabaseAdmin.auth.admin.createUser({
            email: member.email,
            password: newPasswordStr,
            email_confirm: true,
          });
        if (createErr) {
          return json({ error: createErr.message }, 400);
        }
        const { error: linkErr } = await supabaseAdmin
          .from("members")
          .update({ auth_id: created.user.id })
          .eq("id", memberIdStr);
        if (linkErr) {
          return json({ error: linkErr.message }, 400);
        }
      }

      return json({ success: true });
    }

    if (action === "create_login") {
      // 「啟用帳號」: give a member that only has a name (Jira import) a real
      // email and a login. The member row keeps its id, so its tasks,
      // comments and reviews stay as they are.
      const memberIdStr = String(params.memberId ?? "");
      const email = normalizeEmail(params.email);
      if (!memberIdStr) {
        return json({ error: "memberId is required" }, 400);
      }
      if (!isValidEmail(email)) {
        return json({ error: "invalid_email", message: "Email 格式不正確" }, 400);
      }

      const { data: member } = await supabaseAdmin
        .from("members")
        .select("id, name, email, role, is_active")
        .eq("id", memberIdStr)
        .maybeSingle();
      if (!member) {
        return json({ error: "Member not found" }, 404);
      }
      if (member.is_active === false) {
        return json(
          { error: "member_inactive", message: "此成員已停用，請先啟用成員再建立登入帳號" },
          400
        );
      }
      if (!isPlaceholderEmail(member.email)) {
        return json(
          { error: "already_has_login", message: "此成員已有 Email，請改用「重設密碼」" },
          409
        );
      }
      // Same escalation rule as reset_password: whoever creates the login
      // learns (or chooses) its password.
      if (["admin", "super_admin"].includes(member.role || "") && callerRole !== "super_admin") {
        return json(
          { error: "requires_super_admin", message: "只有超級管理員可以為管理員建立登入帳號" },
          403
        );
      }

      // Email already used by another member? (case-insensitive)
      const { data: allMembers, error: membersErr } = await supabaseAdmin
        .from("members")
        .select("id, name, email");
      if (membersErr) {
        return json({ error: membersErr.message }, 400);
      }
      const owner = (allMembers || []).find(
        (m: { id: string; email: string | null }) => m.id !== member.id && normalizeEmail(m.email) === email,
      );
      if (owner) {
        return json(
          { error: "email_taken", message: `此 Email 已是成員「${owner.name}」的帳號`, memberName: owner.name },
          409
        );
      }

      const channel = await resolveLoginChannel(supabaseAdmin, req);
      const authUsers = await loadAuthUsersByEmail(supabaseAdmin);
      let login;
      try {
        login = await prepareLogin(supabaseAdmin, channel.method, { email, name: member.name }, authUsers);
      } catch (err) {
        if (err instanceof LoginError) return json({ error: err.code, message: err.message }, 409);
        return json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }

      const { error: linkErr } = await supabaseAdmin
        .from("members")
        .update({ email, auth_id: login.authUserId })
        .eq("id", member.id);
      if (linkErr) {
        await discardLogin(supabaseAdmin, login);
        return json({ error: linkErr.message }, 400);
      }

      const delivery = await deliverLogin(supabaseAdmin, channel, login, {
        name: member.name,
        email,
        invitedBy: callerName,
      });
      return json({
        success: true,
        memberId: member.id,
        email,
        method: delivery.method,
        ...(delivery.tempPassword ? { tempPassword: delivery.tempPassword } : {}),
        ...(delivery.inviteFailed ? { inviteFailed: true } : {}),
      });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
