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

// HEALTH
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

// GET CALLS
app.get("/calls", async (_req: Request, res: Response) => {
  try {
    const { data, error } = await supabase
      .from("calls")
      .select(`
        id,
        status,
        created_at,
        table_id,
        restaurant_tables (
          id,
          name
        )
      `)
      .eq("status", "ACTIVE")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("GET /calls error:", error);
      return res.status(500).json({ error: error.message });
    }

    return res.json({ calls: data || [] });
  } catch (err: any) {
    console.error("GET /calls catch error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// CLEAR CALL
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
      .select();

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

// FLIC WEBHOOK
app.post("/flic", async (req: Request, res: Response) => {
  try {
    const buttonId =
      req.body?.buttonId ||
      req.body?.bdaddr ||
      req.body?.button;

    if (!buttonId) {
      return res.status(400).json({ error: "buttonId missing" });
    }

    const { data: button, error: buttonError } = await supabase
      .from("buttons")
      .select("*")
      .eq("id", buttonId)
      .single();

    if (buttonError) {
      console.error("POST /flic button lookup error:", buttonError);
    }

    if (!button || !button.table_id) {
      return res.status(400).json({ error: "Button not assigned" });
    }

    const { data: existing, error: existingError } = await supabase
      .from("calls")
      .select("id")
      .eq("table_id", button.table_id)
      .eq("status", "ACTIVE")
      .limit(1);

    if (existingError) {
      console.error("POST /flic existing call lookup error:", existingError);
      return res.status(500).json({ error: existingError.message });
    }

    if (existing && existing.length > 0) {
      return res.json({ message: "Call already active" });
    }

    const { data, error } = await supabase
      .from("calls")
      .insert({
        restaurant_id: button.restaurant_id,
        table_id: button.table_id,
        status: "ACTIVE",
      })
      .select();

    if (error) {
      console.error("POST /flic insert call error:", error);
      return res.status(500).json({ error: error.message });
    }

    return res.status(201).json(data?.[0]);
  } catch (err: any) {
    console.error("POST /flic catch error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET TABLES
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

// CREATE TABLE
app.post("/tables", async (req: Request, res: Response) => {
  try {
    const rawName = req.body?.name;
    const name = typeof rawName === "string" ? rawName.trim() : "";

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

// DELETE TABLE
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

// TABLES WITH BUTTONS
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
      .select("id, name")
      .eq("restaurant_id", DEFAULT_RESTAURANT_ID);

    if (tablesError) {
      console.error("GET /tables-with-buttons tables error:", tablesError);
      return res.status(500).json({ error: tablesError.message });
    }

    const tableMap = new Map<string, string>();
    for (const table of tables || []) {
      tableMap.set(table.id, table.name);
    }

    const result = (buttons || []).map((button) => ({
      id: button.id,
      table_id: button.table_id,
      restaurant_id: button.restaurant_id,
      table_name: button.table_id ? tableMap.get(button.table_id) || null : null,
    }));

    return res.json(result);
  } catch (err: any) {
    console.error("GET /tables-with-buttons catch error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ASSIGN BUTTON
app.post("/buttons/assign", async (req: Request, res: Response) => {
  try {
    const rawButtonId = req.body?.buttonId;
    const rawTableId = req.body?.tableId;

    const buttonId = typeof rawButtonId === "string" ? rawButtonId.trim() : "";
    const tableId = typeof rawTableId === "string" ? rawTableId.trim() : "";

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

// UNASSIGN BUTTON
app.post("/buttons/unassign", async (req: Request, res: Response) => {
  try {
    const rawButtonId = req.body?.buttonId;
    const buttonId = typeof rawButtonId === "string" ? rawButtonId.trim() : "";

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