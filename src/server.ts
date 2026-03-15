import express, { Request, Response } from "express"
import cors from "cors"
import dotenv from "dotenv"
import { createClient } from "@supabase/supabase-js"
import path from "path"

dotenv.config()

const app = express()

app.use(cors())
app.use(express.json())
app.use(express.static(path.join(__dirname, "..")))

const supabaseUrl = process.env.SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env")
}

const supabase = createClient(supabaseUrl, supabaseServiceKey)

const DEFAULT_RESTAURANT_ID = "35c39532-212e-43c1-92f7-068bbd8fd060"



app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "cue-backend"
  })
})



app.get("/calls", async (_req: Request, res: Response) => {
  try {

    const { data, error } = await supabase
      .from("calls")
      .select(`
        id,
        status,
        created_at,
        cleared_at,
        restaurant_id,
        table_id,
        restaurant_tables (
          id,
          name
        )
      `)
      .eq("status", "ACTIVE")
      .order("created_at", { ascending: false })

    if (error) {
      return res.status(500).json({ error: error.message })
    }

    res.json({ calls: data || [] })

  } catch (err) {
    console.error("GET /calls failed:", err)
    res.status(500).json({ error: "Internal server error" })
  }
})



app.post("/calls/:id/clear", async (req: Request, res: Response) => {
  try {

    const callId = req.params.id

    const { data, error } = await supabase
      .from("calls")
      .update({
        status: "CLEARED",
        cleared_at: new Date().toISOString()
      })
      .eq("id", callId)
      .eq("status", "ACTIVE")
      .select()

    if (error) {
      return res.status(500).json({ error: error.message })
    }

    if (!data || data.length === 0) {
      return res.status(404).json({ error: "Call not found" })
    }

    res.json(data[0])

  } catch (err) {
    console.error("POST /calls/:id/clear failed:", err)
    res.status(500).json({ error: "Internal server error" })
  }
})



app.post("/flic", async (req: Request, res: Response) => {
  try {

    const buttonId =
      req.body?.buttonId ||
      req.body?.bdaddr ||
      req.body?.button

    if (!buttonId) {
      return res.status(400).json({
        error: "buttonId missing"
      })
    }

    const { data: button, error: buttonError } = await supabase
      .from("buttons")
      .select("id, restaurant_id, table_id")
      .eq("id", buttonId)
      .single()

    if (buttonError || !button) {
      return res.status(404).json({
        error: "Button not found"
      })
    }

    if (!button.table_id) {
      return res.status(400).json({
        error: "Button not assigned to table"
      })
    }

    const { data: existingCall } = await supabase
      .from("calls")
      .select("*")
      .eq("table_id", button.table_id)
      .eq("status", "ACTIVE")
      .limit(1)

    if (existingCall && existingCall.length > 0) {
      return res.status(200).json({
        message: "Call already active"
      })
    }

    const { data: call, error: callError } = await supabase
      .from("calls")
      .insert({
        restaurant_id: button.restaurant_id,
        table_id: button.table_id,
        status: "ACTIVE"
      })
      .select()

    if (callError) {
      return res.status(500).json({ error: callError.message })
    }

    res.status(201).json(call?.[0])

  } catch (err) {
    console.error("POST /flic failed:", err)
    res.status(500).json({ error: "Internal server error" })
  }
})



app.get("/tables-with-buttons", async (_req: Request, res: Response) => {
  try {

    const { data: tables } = await supabase
      .from("restaurant_tables")
      .select("*")
      .eq("restaurant_id", DEFAULT_RESTAURANT_ID)
      .order("created_at", { ascending: true })

    const { data: buttons } = await supabase
      .from("buttons")
      .select("*")
      .eq("restaurant_id", DEFAULT_RESTAURANT_ID)

    const result = (tables || []).map((table) => {

      const button = (buttons || []).find(
        (b) => b.table_id === table.id
      )

      return {
        tableId: table.id,
        tableName: table.name,
        buttonId: button?.id || null
      }

    })

    res.json(result)

  } catch (err) {
    console.error("GET /tables-with-buttons failed:", err)
    res.status(500).json({ error: "Internal server error" })
  }
})



app.post("/tables", async (req: Request, res: Response) => {
  try {

    const { name } = req.body as { name?: string }

    if (!name) {
      return res.status(400).json({ error: "name required" })
    }

    const { data, error } = await supabase
      .from("restaurant_tables")
      .insert({
        name,
        restaurant_id: DEFAULT_RESTAURANT_ID
      })
      .select()

    if (error) {
      return res.status(500).json({ error: error.message })
    }

    res.status(201).json(data?.[0])

  } catch (err) {
    console.error("POST /tables failed:", err)
    res.status(500).json({ error: "Internal server error" })
  }
})



app.post("/buttons/assign", async (req: Request, res: Response) => {
  try {

    const { buttonId, tableId } = req.body as {
      buttonId?: string
      tableId?: string
    }

    if (!buttonId || !tableId) {
      return res.status(400).json({
        error: "buttonId and tableId required"
      })
    }

    const { data: existing } = await supabase
      .from("buttons")
      .select("*")
      .eq("table_id", tableId)
      .neq("id", buttonId)
      .limit(1)

    if (existing && existing.length > 0) {
      return res.status(400).json({
        error: "Table already has a button"
      })
    }

    const { data, error } = await supabase
      .from("buttons")
      .update({
        table_id: tableId
      })
      .eq("id", buttonId)
      .select()

    if (error) {
      return res.status(500).json({ error: error.message })
    }

    res.json(data?.[0])

  } catch (err) {
    console.error("POST /buttons/assign failed:", err)
    res.status(500).json({ error: "Internal server error" })
  }
})



app.post("/buttons/unassign", async (req: Request, res: Response) => {
  try {

    const { buttonId } = req.body as {
      buttonId?: string
    }

    if (!buttonId) {
      return res.status(400).json({
        error: "buttonId required"
      })
    }

    const { data, error } = await supabase
      .from("buttons")
      .update({
        table_id: null
      })
      .eq("id", buttonId)
      .select()

    if (error) {
      return res.status(500).json({ error: error.message })
    }

    res.json({
      message: "Button unassigned",
      button: data?.[0]
    })

  } catch (err) {
    console.error("POST /buttons/unassign failed:", err)
    res.status(500).json({ error: "Internal server error" })
  }
})



const PORT = Number(process.env.PORT) || 3000

app.listen(PORT, () => {
  console.log(`Cue backend running on port ${PORT}`)
})