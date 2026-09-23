use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Shipment {
    pub id: String,
    pub supplier: String,
    pub tracking_number: Option<String>,
    pub carrier: Option<String>,
    pub recipient: Option<String>,
    pub material: String,
    pub status: String,
    pub expected_date: Option<String>,
    pub received_date: Option<String>,
    pub notes: Option<String>,
    /// Option de bon de transport TNT : "with_pickup" (avec ramassage
    /// occasionnel) ou "without_pickup" (sans). Non pertinent hors TNT —
    /// reste `None` pour les autres transporteurs, jamais déduit.
    pub pickup_option: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct NewShipment {
    pub supplier: String,
    pub tracking_number: Option<String>,
    pub carrier: Option<String>,
    pub recipient: Option<String>,
    pub material: String,
    pub expected_date: Option<String>,
    pub notes: Option<String>,
    pub pickup_option: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateShipment {
    pub id: String,
    pub supplier: String,
    pub tracking_number: Option<String>,
    pub carrier: Option<String>,
    pub recipient: Option<String>,
    pub material: String,
    pub status: String,
    pub expected_date: Option<String>,
    pub received_date: Option<String>,
    pub notes: Option<String>,
    pub pickup_option: Option<String>,
}
