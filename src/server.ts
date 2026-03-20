import express, { Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import path from "path";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "..")));

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY!;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error("Missing Supabase environment variables");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

const DEFAULT_RESTAURANT_ID = "35c39532-212e-43c1-92f7-068bbd8fd060";

// -----------------------------
// HELPERS
// -----------------------------
function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeButtonId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function getCoverageAreaNameMap() {
  const { data, error } = await supabase
    .from("coverage_areas")
    .select("id, name")
    .eq("restaurant_id", DEFAULT_RESTAURANT_ID);

  if (error) {
    throw new Error(error.message);
  }

  const map = new Map<string, string>();
  for (const item of data || []) {
    map.set(item.id, item.name);
  }
  return map;
}

async function handleButtonToggle(buttonId: string) {
  const { data: button, error: buttonError } = await supabase
    .from("buttons")
    .select("*")
    .eq("id", buttonId)
    .single();

  if (buttonError) {
    console.error("Button lookup error:", buttonError);
    throw new Error(buttonError.message);
  }

  if (!button || !button.table_id) {
    const err: any = new Error("Button not assigned");
    err.statusCode = 400;
    throw err;
  }

  const { data: existingCalls, error: existingError } = await supabase
    .from("calls")
    .select("id, status, created_at, table_id")
    .eq("table_id", button.table_id)
    .eq("status", "ACTIVE")
    .order("created_at", { ascending: false })
    .limit(1);

  if (existingError) {
    console.error("Existing call lookup error:", existingError);
    throw new Error(existingError.message);
  }

  const activeCall = existingCalls && existingCalls.length > 0 ? existingCalls[0] : null;

  if (activeCall) {
    const { data: clearedData, error: clearError } = await supabase
      .from("calls")
      .update({
        status: "CLEARED",
        cleared_at: new Date().toISOString(),
      })
      .eq("id", activeCall.id)
      .select(`
        id,
        status,
        created_at,
        cleared_at,
        table_id,
        restaurant_tables (
          id,
          name
        )
      `);

    if (clearError) {
      console.error("Clear active call error:", clearError);
      throw new Error(clearError.message);
    }

    return {
      action: "cleared",
      call: clearedData?.[0] || null,
      table_id: button.table_id,
      button_id: button.id,
      message: "Active call cleared",
    };
  }

  const { data: createdData, error: insertError } = await supabase
    .from("calls")
    .insert({
      restaurant_id: button.restaurant_id || DEFAULT_RESTAURANT_ID,
      table_id: button.table_id,
      status: "ACTIVE",
    })
    .select(`
      id,
      status,
      created_at,
      table_id,
      restaurant_tables (
        id,
        name
      )
    `);

  if (insertError) {
    console.error("Create call error:", insertError);
    throw new Error(insertError.message);
  }

  return {
    action: "created",
    call: createdData?.[0] || null,
    table_id: button.table_id,
    button_id: button.id,
    message: "New call created",
  };
}

// -----------------------------
// HEALTH
// -----------------------------
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

// -----------------------------
// GET ACTIVE CALLS
// -----------------------------
app.get("/calls", async (_req: Request, res: Response) => {
  try {
    const { data, error } = await supabase
      .from("calls")
      .select(`
        id,
        status,
        created_at,
        cleared_at,
        table_id,
        restaurant_tables (
          id,
          name,
          coverage_area_id
        )
      `)
      .eq("status", "ACTIVE")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("GET /calls error:", error);
      return res.status(500).json({ error: error.message });
    }

    const areaMap = await getCoverageAreaNameMap();

    const calls = (data || []).map((call: any) => ({
      ...call,
      coverage_area_name: call?.restaurant_tables?.coverage_area_id
        ? areaMap.get(call.restaurant_tables.coverage_area_id) || null
        : null,
    }));

    return res.json({ calls });
  } catch (err: any) {
    console.error("GET /calls catch error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// -----------------------------
// CLEAR CALL
// -----------------------------
app.post("/calls/:id/clear", async (req: Request, res: Response) => {
  try {
    const callId = req.params.id;

    if (!callId) {
      return res.status(400).json({ error: "call id required" });
    }

    const { data, error } = await supabase
      .from("calls")
      .update({
        status: "CLEARED",
        cleared_at: new Date().toISOString(),
      })
      .eq("id", callId)
      .select(`
        id,
        status,
        created_at,
        cleared_at,
        table_id,
        restaurant_tables (
          id,
          name
        )
      `);

    if (error) {
      console.error("POST /calls/:id/clear error:", error);
      return res.status(500).json({ error: error.message });
    }

    return res.json(data?.[0] || { message: "Call cleared" });
  } catch (err: any) {
    console.error("POST /calls/:id/clear catch error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// -----------------------------
// FLIC WEBHOOK
// -----------------------------
app.post("/flic", async (req: Request, res: Response) => {
  try {
    const buttonId = normalizeButtonId(
      req.body?.buttonId ||
      req.body?.bdaddr ||
      req.body?.button ||
      req.body?.button_id ||
      req.body?.id
    );

    if (!buttonId) {
      return res.status(400).json({ error: "buttonId missing" });
    }

    const result = await handleButtonToggle(buttonId);

    return res.status(result.action === "created" ? 201 : 200).json(result);
  } catch (err: any) {
    console.error("POST /flic catch error:", err);

    if (err?.statusCode) {
      return res.status(err.statusCode).json({ error: err.message });
    }

    return res.status(500).json({ error: err.message || "Internal server error" });
  }
});

// -----------------------------
// BUTTON PRESS ALIAS
// -----------------------------
app.post("/button-press", async (req: Request, res: Response) => {
  try {
    const buttonId = normalizeButtonId(
      req.body?.buttonId ||
      req.body?.bdaddr ||
      req.body?.button ||
      req.body?.button_id ||
      req.body?.id
    );

    if (!buttonId) {
      return res.status(400).json({ error: "buttonId missing" });
    }

    const result = await handleButtonToggle(buttonId);

    return res.status(result.action === "created" ? 201 : 200).json(result);
  } catch (err: any) {
    console.error("POST /button-press catch error:", err);

    if (err?.statusCode) {
      return res.status(err.statusCode).json({ error: err.message });
    }

    return res.status(500).json({ error: err.message || "Internal server error" });
  }
});

// -----------------------------
// GET TABLES
// -----------------------------
app.get("/tables", async (_req: Request, res: Response) => {
  try {
    const { data, error } = await supabase
      .from("restaurant_tables")
      .select("*")
      .eq("restaurant_id", DEFAULT_RESTAURANT_ID)
      .order("created_at", { ascending: true });

    if (error) {
      console.error("GET /tables error:", error);
      return res.status(500).json({ error: error.message });
    }

    return res.json(data || []);
  } catch (err: any) {
    console.error("GET /tables catch error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// -----------------------------
// GET TABLES WITH AREA INFO
// -----------------------------
app.get("/tables-with-areas", async (_req: Request, res: Response) => {
  try {
    const { data: tables, error: tablesError } = await supabase
      .from("restaurant_tables")
      .select("id, name, restaurant_id, coverage_area_id")
      .eq("restaurant_id", DEFAULT_RESTAURANT_ID)
      .order("created_at", { ascending: true });

    if (tablesError) {
      console.error("GET /tables-with-areas tables error:", tablesError);
      return res.status(500).json({ error: tablesError.message });
    }

    const { data: areas, error: areasError } = await supabase
      .from("coverage_areas")
      .select("id, name")
      .eq("restaurant_id", DEFAULT_RESTAURANT_ID)
      .order("created_at", { ascending: true });

    if (areasError) {
      console.error("GET /tables-with-areas areas error:", areasError);
      return res.status(500).json({ error: areasError.message });
    }

    const areaMap = new Map<string, string>();
    for (const area of areas || []) {
      areaMap.set(area.id, area.name);
    }

    const result = (tables || []).map((table: any) => ({
      ...table,
      coverage_area_name: table.coverage_area_id
        ? areaMap.get(table.coverage_area_id) || null
        : null,
    }));

    return res.json(result);
  } catch (err: any) {
    console.error("GET /tables-with-areas catch error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// -----------------------------
// CREATE TABLE
// -----------------------------
app.post("/tables", async (req: Request, res: Response) => {
  try {
    const name = normalizeString(req.body?.name);

    if (!name) {
      return res.status(400).json({ error: "name required" });
    }

    const { data, error } = await supabase
      .from("restaurant_tables")
      .insert({
        name,
        restaurant_id: DEFAULT_RESTAURANT_ID,
      })
      .select();

    if (error) {
      console.error("POST /tables error:", error);
      return res.status(500).json({ error: error.message });
    }

    return res.json(data?.[0]);
  } catch (err: any) {
    console.error("POST /tables catch error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// -----------------------------
// ASSIGN COVERAGE AREA TO TABLE
// -----------------------------
app.post("/tables/:id/assign-coverage-area", async (req: Request, res: Response) => {
  try {
    const tableId = req.params.id;
    const coverageAreaIdRaw = req.body?.coverageAreaId;

    if (!tableId) {
      return res.status(400).json({ error: "table id required" });
    }

    const coverageAreaId =
      coverageAreaIdRaw === null || coverageAreaIdRaw === ""
        ? null
        : normalizeString(coverageAreaIdRaw);

    const { data: table, error: tableError } = await supabase
      .from("restaurant_tables")
      .select("id, name, restaurant_id")
      .eq("id", tableId)
      .eq("restaurant_id", DEFAULT_RESTAURANT_ID)
      .single();

    if (tableError || !table) {
      return res.status(404).json({ error: "table not found" });
    }

    if (coverageAreaId) {
      const { data: area, error: areaError } = await supabase
        .from("coverage_areas")
        .select("id, name, restaurant_id")
        .eq("id", coverageAreaId)
        .eq("restaurant_id", DEFAULT_RESTAURANT_ID)
        .single();

      if (areaError || !area) {
        return res.status(404).json({ error: "coverage area not found" });
      }
    }

    const { data, error } = await supabase
      .from("restaurant_tables")
      .update({
        coverage_area_id: coverageAreaId,
      })
      .eq("id", tableId)
      .select("id, name, coverage_area_id")
      .single();

    if (error) {
      console.error("POST /tables/:id/assign-coverage-area error:", error);
      return res.status(500).json({ error: error.message });
    }

    const areaMap = await getCoverageAreaNameMap();

    return res.json({
      ...data,
      coverage_area_name: data.coverage_area_id
        ? areaMap.get(data.coverage_area_id) || null
        : null,
    });
  } catch (err: any) {
    console.error("POST /tables/:id/assign-coverage-area catch error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// -----------------------------
// DELETE TABLE
// -----------------------------
app.delete("/tables/:id", async (req: Request, res: Response) => {
  try {
    const tableId = req.params.id;

    if (!tableId) {
      return res.status(400).json({ error: "table id required" });
    }

    const { error: unassignButtonsError } = await supabase
      .from("buttons")
      .update({ table_id: null })
      .eq("table_id", tableId);

    if (unassignButtonsError) {
      console.error("DELETE /tables/:id unassign buttons error:", unassignButtonsError);
      return res.status(500).json({
        error: "Failed to unassign buttons",
        details: unassignButtonsError.message,
      });
    }

    const { error: deleteCallsError } = await supabase
      .from("calls")
      .delete()
      .eq("table_id", tableId);

    if (deleteCallsError) {
      console.error("DELETE /tables/:id delete calls error:", deleteCallsError);
      return res.status(500).json({
        error: "Failed to delete calls for table",
        details: deleteCallsError.message,
      });
    }

    const { error: deleteTableError } = await supabase
      .from("restaurant_tables")
      .delete()
      .eq("id", tableId);

    if (deleteTableError) {
      console.error("DELETE /tables/:id delete table error:", deleteTableError);
      return res.status(500).json({
        error: "Failed to delete table",
        details: deleteTableError.message,
      });
    }

    return res.json({
      success: true,
      message: "Table deleted",
      deletedTableId: tableId,
    });
  } catch (err: any) {
    console.error("DELETE /tables/:id catch error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// -----------------------------
// GET COVERAGE AREAS
// -----------------------------
app.get("/coverage-areas", async (_req: Request, res: Response) => {
  try {
    const { data, error } = await supabase
      .from("coverage_areas")
      .select("id, restaurant_id, name, created_at")
      .eq("restaurant_id", DEFAULT_RESTAURANT_ID)
      .order("created_at", { ascending: true });

    if (error) {
      console.error("GET /coverage-areas error:", error);
      return res.status(500).json({ error: error.message });
    }

    const { data: tables, error: tablesError } = await supabase
      .from("restaurant_tables")
      .select("id, coverage_area_id")
      .eq("restaurant_id", DEFAULT_RESTAURANT_ID);

    if (tablesError) {
      console.error("GET /coverage-areas table count error:", tablesError);
      return res.status(500).json({ error: tablesError.message });
    }

    const countMap = new Map<string, number>();
    for (const table of tables || []) {
      if (!table.coverage_area_id) continue;
      countMap.set(table.coverage_area_id, (countMap.get(table.coverage_area_id) || 0) + 1);
    }

    const result = (data || []).map((area: any) => ({
      ...area,
      table_count: countMap.get(area.id) || 0,
    }));

    return res.json(result);
  } catch (err: any) {
    console.error("GET /coverage-areas catch error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// -----------------------------
// CREATE COVERAGE AREA
// -----------------------------
app.post("/coverage-areas", async (req: Request, res: Response) => {
  try {
    const name = normalizeString(req.body?.name);

    if (!name) {
      return res.status(400).json({ error: "name required" });
    }

    const { data, error } = await supabase
      .from("coverage_areas")
      .insert({
        name,
        restaurant_id: DEFAULT_RESTAURANT_ID,
      })
      .select()
      .single();

    if (error) {
      console.error("POST /coverage-areas error:", error);
      return res.status(500).json({ error: error.message });
    }

    return res.json({
      ...data,
      table_count: 0,
    });
  } catch (err: any) {
    console.error("POST /coverage-areas catch error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// -----------------------------
// DELETE COVERAGE AREA
// -----------------------------
app.delete("/coverage-areas/:id", async (req: Request, res: Response) => {
  try {
    const areaId = req.params.id;

    if (!areaId) {
      return res.status(400).json({ error: "coverage area id required" });
    }

    const { error: unassignTablesError } = await supabase
      .from("restaurant_tables")
      .update({ coverage_area_id: null })
      .eq("coverage_area_id", areaId)
      .eq("restaurant_id", DEFAULT_RESTAURANT_ID);

    if (unassignTablesError) {
      console.error("DELETE /coverage-areas/:id unassign tables error:", unassignTablesError);
      return res.status(500).json({ error: unassignTablesError.message });
    }

    const { error: deleteError } = await supabase
      .from("coverage_areas")
      .delete()
      .eq("id", areaId)
      .eq("restaurant_id", DEFAULT_RESTAURANT_ID);

    if (deleteError) {
      console.error("DELETE /coverage-areas/:id error:", deleteError);
      return res.status(500).json({ error: deleteError.message });
    }

    return res.json({ success: true, deletedCoverageAreaId: areaId });
  } catch (err: any) {
    console.error("DELETE /coverage-areas/:id catch error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// -----------------------------
// TABLES WITH BUTTONS
// -----------------------------
app.get("/tables-with-buttons", async (_req: Request, res: Response) => {
  try {
    const { data: buttons, error: buttonsError } = await supabase
      .from("buttons")
      .select("id, table_id, restaurant_id")
      .eq("restaurant_id", DEFAULT_RESTAURANT_ID)
      .order("id", { ascending: true });

    if (buttonsError) {
      console.error("GET /tables-with-buttons buttons error:", buttonsError);
      return res.status(500).json({ error: buttonsError.message });
    }

    const { data: tables, error: tablesError } = await supabase
      .from("restaurant_tables")
      .select("id, name, coverage_area_id")
      .eq("restaurant_id", DEFAULT_RESTAURANT_ID);

    if (tablesError) {
      console.error("GET /tables-with-buttons tables error:", tablesError);
      return res.status(500).json({ error: tablesError.message });
    }

    const areaMap = await getCoverageAreaNameMap();

    const tableMap = new Map<string, { name: string; coverage_area_id: string | null }>();
    for (const table of tables || []) {
      tableMap.set(table.id, {
        name: table.name,
        coverage_area_id: table.coverage_area_id || null,
      });
    }

    const result = (buttons || []).map((button: any) => {
      const tableInfo = button.table_id ? tableMap.get(button.table_id) : null;

      return {
        id: button.id,
        table_id: button.table_id,
        restaurant_id: button.restaurant_id,
        table_name: tableInfo?.name || null,
        coverage_area_id: tableInfo?.coverage_area_id || null,
        coverage_area_name: tableInfo?.coverage_area_id
          ? areaMap.get(tableInfo.coverage_area_id) || null
          : null,
      };
    });

    return res.json(result);
  } catch (err: any) {
    console.error("GET /tables-with-buttons catch error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// -----------------------------
// ASSIGN BUTTON
// -----------------------------
app.post("/buttons/assign", async (req: Request, res: Response) => {
  try {
    const buttonId = normalizeString(req.body?.buttonId);
    const tableId = normalizeString(req.body?.tableId);

    if (!buttonId || !tableId) {
      return res.status(400).json({ error: "missing fields" });
    }

    const { data: table, error: tableError } = await supabase
      .from("restaurant_tables")
      .select("id, name")
      .eq("id", tableId)
      .eq("restaurant_id", DEFAULT_RESTAURANT_ID)
      .single();

    if (tableError || !table) {
      console.error("POST /buttons/assign table lookup error:", tableError);
      return res.status(400).json({ error: "table not found" });
    }

    const { data: existing, error: existingError } = await supabase
      .from("buttons")
      .select("*")
      .eq("id", buttonId)
      .single();

    if (existingError && existingError.code !== "PGRST116") {
      console.error("POST /buttons/assign existing button lookup error:", existingError);
      return res.status(500).json({ error: existingError.message });
    }

    if (existing) {
      const { data, error } = await supabase
        .from("buttons")
        .update({
          table_id: tableId,
          restaurant_id: DEFAULT_RESTAURANT_ID,
        })
        .eq("id", buttonId)
        .select();

      if (error) {
        console.error("POST /buttons/assign update error:", error);
        return res.status(500).json({ error: error.message });
      }

      return res.json({
        ...(data?.[0] || {}),
        table_name: table.name,
      });
    }

    const { data, error } = await supabase
      .from("buttons")
      .insert({
        id: buttonId,
        table_id: tableId,
        restaurant_id: DEFAULT_RESTAURANT_ID,
      })
      .select();

    if (error) {
      console.error("POST /buttons/assign insert error:", error);
      return res.status(500).json({ error: error.message });
    }

    return res.json({
      ...(data?.[0] || {}),
      table_name: table.name,
    });
  } catch (err: any) {
    console.error("POST /buttons/assign catch error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// -----------------------------
// UNASSIGN BUTTON
// -----------------------------
app.post("/buttons/unassign", async (req: Request, res: Response) => {
  try {
    const buttonId = normalizeString(req.body?.buttonId);

    if (!buttonId) {
      return res.status(400).json({ error: "buttonId required" });
    }

    const { data, error } = await supabase
      .from("buttons")
      .update({ table_id: null })
      .eq("id", buttonId)
      .select();

    if (error) {
      console.error("POST /buttons/unassign error:", error);
      return res.status(500).json({ error: error.message });
    }

    return res.json(data?.[0] || { message: "Button unassigned" });
  } catch (err: any) {
    console.error("POST /buttons/unassign catch error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, () => {
  console.log(`Cue backend running on port ${PORT}`);
});