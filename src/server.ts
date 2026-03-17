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

    if (error) return res.status(500).json({ error: error.message });

    res.json({ calls: data || [] });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});


// CLEAR CALL
app.post("/calls/:id/clear", async (req: Request, res: Response) => {
  try {
    const callId = req.params.id;

    const { data, error } = await supabase
      .from("calls")
      .update({
        status: "CLEARED",
        cleared_at: new Date().toISOString()
      })
      .eq("id", callId)
      .select();

    if (error) return res.status(500).json({ error: error.message });

    res.json(data?.[0]);
  } catch {
    res.status(500).json({ error: "Internal server error" });
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

    const { data: button } = await supabase
      .from("buttons")
      .select("*")
      .eq("id", buttonId)
      .single();

    if (!button || !button.table_id) {
      return res.status(400).json({ error: "Button not assigned" });
    }

    const { data: existing } = await supabase
      .from("calls")
      .select("id")
      .eq("table_id", button.table_id)
      .eq("status", "ACTIVE")
      .limit(1);

    if (existing && existing.length > 0) {
      return res.json({ message: "Call already active" });
    }

    const { data, error } = await supabase
      .from("calls")
      .insert({
        restaurant_id: button.restaurant_id,
        table_id: button.table_id,
        status: "ACTIVE"
      })
      .select();

    if (error) return res.status(500).json({ error: error.message });

    res.status(201).json(data?.[0]);
  } catch {
    res.status(500).json({ error: "Internal server error" });
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

    if (error) return res.status(500).json({ error: error.message });

    res.json(data || []);
  } catch {
    res.status(500).json({ error: "Internal server error" });
  }
});


// CREATE TABLE
app.post("/tables", async (req: Request, res: Response) => {
  try {
    const { name } = req.body;

    if (!name) return res.status(400).json({ error: "name required" });

    const { data, error } = await supabase
      .from("restaurant_tables")
      .insert({
        name,
        restaurant_id: DEFAULT_RESTAURANT_ID
      })
      .select();

    if (error) return res.status(500).json({ error: error.message });

    res.json(data?.[0]);
  } catch {
    res.status(500).json({ error: "Internal server error" });
  }
});


// DELETE TABLE 🚀
app.delete("/tables/:id", async (req: Request, res: Response) => {
  try {
    const tableId = req.params.id;

    if (!tableId) {
      return res.status(400).json({ error: "table id required" });
    }

    // estä jos button kiinni
    const { data: buttons } = await supabase
      .from("buttons")
      .select("id")
      .eq("table_id", tableId)
      .limit(1);

    if (buttons && buttons.length > 0) {
      return res.status(400).json({
        error: "Table has button assigned"
      });
    }

    // estä jos active call
    const { data: calls } = await supabase
      .from("calls")
      .select("id")
      .eq("table_id", tableId)
      .eq("status", "ACTIVE")
      .limit(1);

    if (calls && calls.length > 0) {
      return res.status(400).json({
        error: "Table has active call"
      });
    }

    const { error } = await supabase
      .from("restaurant_tables")
      .delete()
      .eq("id", tableId);

    if (error) return res.status(500).json({ error: error.message });

    res.json({ message: "Table deleted" });
  } catch {
    res.status(500).json({ error: "Internal server error" });
  }
});


// TABLES WITH BUTTONS
app.get("/tables-with-buttons", async (_req: Request, res: Response) => {
  try {
    const { data } = await supabase
      .from("buttons")
      .select(`
        id,
        table_id,
        restaurant_tables (
          id,
          name
        )
      `)
      .eq("restaurant_id", DEFAULT_RESTAURANT_ID);

    res.json(data || []);
  } catch {
    res.status(500).json({ error: "Internal server error" });
  }
});


// ASSIGN BUTTON
app.post("/buttons/assign", async (req: Request, res: Response) => {
  try {
    const { buttonId, tableId } = req.body;

    if (!buttonId || !tableId) {
      return res.status(400).json({ error: "missing fields" });
    }

    const { data: existing } = await supabase
      .from("buttons")
      .select("*")
      .eq("id", buttonId)
      .single();

    if (existing) {
      const { data, error } = await supabase
        .from("buttons")
        .update({ table_id: tableId })
        .eq("id", buttonId)
        .select();

      if (error) return res.status(500).json({ error: error.message });

      return res.json(data?.[0]);
    }

    const { data, error } = await supabase
      .from("buttons")
      .insert({
        id: buttonId,
        table_id: tableId,
        restaurant_id: DEFAULT_RESTAURANT_ID
      })
      .select();

    if (error) return res.status(500).json({ error: error.message });

    res.json(data?.[0]);
  } catch {
    res.status(500).json({ error: "Internal server error" });
  }
});


// UNASSIGN BUTTON
app.post("/buttons/unassign", async (req: Request, res: Response) => {
  try {
    const { buttonId } = req.body;

    const { data, error } = await supabase
      .from("buttons")
      .update({ table_id: null })
      .eq("id", buttonId)
      .select();

    if (error) return res.status(500).json({ error: error.message });

    res.json(data?.[0]);
  } catch {
    res.status(500).json({ error: "Internal server error" });
  }
});


const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, () => {
  console.log(`Cue backend running on port ${PORT}`);
});