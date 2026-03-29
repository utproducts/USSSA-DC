// usssa-poller worker — USSSA Director's Console proxy
// Handles team search, divisions, venues, and event-team KV storage

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// USSSA stateID mapping (numeric IDs used by dc.usssa.com)
const STATE_IDS = {
  AL:1, AK:2, AZ:3, AR:4, CA:5, CO:6, CT:7, DE:8, FL:9, GA:10,
  HI:11, ID:12, IL:13, IN:14, IA:15, KS:16, KY:17, LA:18, ME:19, MD:20,
  MA:21, MI:22, MN:23, MS:24, MO:25, MT:26, NE:27, NV:28, NH:29, NJ:30,
  NM:31, NY:32, NC:33, ND:34, OH:35, OK:36, OR:37, PA:38, RI:39, SC:40,
  SD:41, TN:42, TX:43, UT:44, VT:45, VA:46, WA:47, WV:48, WI:49, WY:50,
  DC:51, PR:52, VI:53,
};

// Normalize raw USSSA team object into the shape the app expects
function normalizeTeam(t) {
  return {
    id:            String(t.TeamID   || t.teamID   || t.id    || ""),
    name:          t.TeamName  || t.teamName  || t.name  || "",
    cls:           t.ClassName || t.className || t.cls   || t.division || "",
    city:          t.City      || t.city      || "",
    state:         t.State     || t.state     || "",
    manager_name:  t.ManagerName  || t.managerName  || t.manager || "",
    manager_email: t.ManagerEmail || t.managerEmail || t.email   || "",
    manager_phone: t.ManagerPhone || t.managerPhone || t.phone   || "",
    entry_status:  t.EntryStatus  || t.entryStatus  || t.entry_status  || "",
    payment_status:t.PaymentStatus|| t.paymentStatus|| t.payment_status|| "",
    // keep originals too in case the app reads other fields
    ...t,
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url  = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    // ── /teams-search — searches the KV-backed known_teams index ──
    if (path === "/teams-search" && request.method === "GET") {
      const stateFilter = (url.searchParams.get("state") || "").toUpperCase().trim();
      const ageRaw      = url.searchParams.get("age") || "";
      const nameQ       = (url.searchParams.get("name") || url.searchParams.get("q") || "").toLowerCase().trim();
      const ageNum      = parseInt(ageRaw, 10);

      try {
        // Load the global known_teams index built from all seeded events
        const index = await env.USSSA_DIVISIONS.get("known_teams", { type: "json" }) || [];

        let teams = index;

        // Filter by state
        if (stateFilter && stateFilter !== "ALL") {
          teams = teams.filter(t => (t.team_state || t.state || "").toUpperCase() === stateFilter);
        }

        // Filter by age (from division label, e.g. "14AA" → 14)
        if (!isNaN(ageNum)) {
          teams = teams.filter(t => {
            const div = String(t.division || t.cls || "");
            const m   = div.match(/^(\d+)/);
            return m ? parseInt(m[1], 10) === ageNum : true;
          });
        }

        // Filter by name substring
        if (nameQ) {
          teams = teams.filter(t => (t.team_name || t.name || "").toLowerCase().includes(nameQ));
        }

        // Deduplicate by team_id
        const seen = new Set();
        teams = teams.filter(t => {
          const key = t.team_id || t.id || t.team_name;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        return json({ status: "ok", teams, count: teams.length, source: "kv-index" });
      } catch (e) {
        return json({ status: "error", message: e.message, teams: [] }, 500);
      }
    }

    // ── /teams-index/rebuild — scans all event_teams_* keys and rebuilds index ──
    if (path === "/teams-index/rebuild" && request.method === "GET") {
      try {
        const list   = await env.USSSA_DIVISIONS.list({ prefix: "event_teams_" });
        const allTeams = [];
        for (const key of list.keys) {
          const data = await env.USSSA_DIVISIONS.get(key.name, { type: "json" });
          if (data && Array.isArray(data.teams)) allTeams.push(...data.teams);
        }
        // Deduplicate by team_id
        const seen = new Set();
        const unique = allTeams.filter(t => {
          const k = t.team_id || t.team_name;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        await env.USSSA_DIVISIONS.put("known_teams", JSON.stringify(unique));
        return json({ status: "ok", total: unique.length, events: list.keys.length });
      } catch (e) {
        return json({ status: "error", message: e.message }, 500);
      }
    }

    // ── /venues ──
    if (path === "/venues" && request.method === "GET") {
      try {
        const cached = await env.USSSA_DIVISIONS.get("venues_fl_seed", { type: "json" });
        if (cached) return json(cached);
        const fresh = await fetchVenues();
        await env.USSSA_DIVISIONS.put("venues_fl_seed", JSON.stringify(fresh));
        return json(fresh);
      } catch (e) { return json({ error: e.message }, 500); }
    }

    if (path === "/venues/reseed" && request.method === "GET") {
      try {
        const fresh = await fetchVenues();
        await env.USSSA_DIVISIONS.put("venues_fl_seed", JSON.stringify(fresh));
        return json({ ok: true, count: fresh.length });
      } catch (e) { return json({ error: e.message }, 500); }
    }

    if (path === "/venues/seed" && request.method === "POST") {
      try {
        const body = await request.json();
        if (!Array.isArray(body)) return json({ error: "Expected array" }, 400);
        await env.USSSA_DIVISIONS.put("venues_fl_seed", JSON.stringify(body));
        return json({ ok: true, count: body.length });
      } catch (e) { return json({ error: e.message }, 500); }
    }

    if (path === "/venues/custom" && request.method === "GET") {
      const data = await env.USSSA_DIVISIONS.get("venues_custom", { type: "json" }) || [];
      return json(data);
    }

    if (path === "/venues/custom" && request.method === "POST") {
      try {
        const body     = await request.json();
        const existing = await env.USSSA_DIVISIONS.get("venues_custom", { type: "json" }) || [];
        const updated  = [...existing, body];
        await env.USSSA_DIVISIONS.put("venues_custom", JSON.stringify(updated));
        return json({ ok: true, total: updated.length });
      } catch (e) { return json({ error: e.message }, 500); }
    }

    // ── /divisions ──
    if (path === "/divisions" && request.method === "GET") {
      try {
        const cached = await env.USSSA_DIVISIONS.get("divisions_fl", { type: "json" });
        if (cached) return json(cached);
        const fresh = await fetchDivisions();
        await env.USSSA_DIVISIONS.put("divisions_fl", JSON.stringify(fresh));
        return json(fresh);
      } catch (e) { return json({ error: e.message }, 500); }
    }

    if (path === "/divisions/refresh" && request.method === "GET") {
      try {
        const fresh = await fetchDivisions();
        await env.USSSA_DIVISIONS.put("divisions_fl", JSON.stringify(fresh));
        return json({ ok: true, count: fresh.length });
      } catch (e) { return json({ error: e.message }, 500); }
    }

    // ── /event-teams ──
    if (path === "/event-teams/seed" && request.method === "POST") {
      try {
        const body    = await request.json();
        const eventId = String(body.event_id || "").trim();
        const teams   = body.teams;
        if (!eventId || !Array.isArray(teams))
          return json({ status: "error", error: "event_id and teams[] required" }, 400);

        // Save event-specific teams
        await env.USSSA_DIVISIONS.put(`event_teams_${eventId}`, JSON.stringify({ teams, seeded_at: new Date().toISOString() }));

        // Merge into global known_teams index (background, non-blocking)
        ctx.waitUntil((async () => {
          try {
            const existing = await env.USSSA_DIVISIONS.get("known_teams", { type: "json" }) || [];
            const existingIds = new Set(existing.map(t => t.team_id || t.team_name));
            const newTeams = teams.filter(t => !existingIds.has(t.team_id || t.team_name));
            if (newTeams.length > 0) {
              await env.USSSA_DIVISIONS.put("known_teams", JSON.stringify([...existing, ...newTeams]));
            }
          } catch (_) {}
        })());

        return json({ status: "ok", seeded: teams.length, event_id: eventId });
      } catch (e) { return json({ status: "error", error: e.message }, 500); }
    }

    if (path === "/event-teams" && request.method === "GET") {
      const eventId = url.searchParams.get("event_id") || "";
      if (!eventId) return json({ status: "error", error: "event_id required", teams: [] }, 400);
      try {
        const cached = await env.USSSA_DIVISIONS.get(`event_teams_${eventId}`, "json");
        if (cached && Array.isArray(cached.teams) && cached.teams.length > 0)
          return json({ status: "ok", teams: cached.teams, count: cached.teams.length, event_id: eventId, source: "kv" });
        return json({ status: "ok", teams: [], count: 0, event_id: eventId, source: "empty" });
      } catch (e) { return json({ status: "error", error: e.message, teams: [] }, 500); }
    }

    return json({ error: "Not found", path }, 404);
  },
};

async function fetchVenues() {
  const resp = await fetch("https://dc.usssa.com/api/getFilteredLocations?sportID=11&stateID=9", { headers: { Accept: "application/json" } });
  const raw  = await resp.json();
  const parks = Array.isArray(raw) ? raw : raw.data || raw.locations || [];
  return parks.map(p => ({ id: String(p.ID || p.id || ""), name: p.name || p.Name || "", state: "FL" }));
}

async function fetchDivisions() {
  const resp = await fetch("https://dc.usssa.com/api/getDivisionList?sportID=11&stateID=9", { headers: { Accept: "application/json" } });
  const raw  = await resp.json();
  return Array.isArray(raw) ? raw : raw.data || raw.divisions || [];
}
