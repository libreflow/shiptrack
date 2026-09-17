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
}
