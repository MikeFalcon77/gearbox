//! greeter, scaffolded by Gearbox Studio.

use axum::{Json, http::StatusCode};
use serde::Serialize;
use toolkit::api::{Missing, OperationBuilder};
use toolkit::contracts::{OpenApiRegistry, RestApiCapability};
use toolkit::{Gear, GearCtx};

#[toolkit::gear(name = "greeter", capabilities = [rest])]
#[derive(Default)]
pub struct Greeter;

#[toolkit::async_trait]
impl Gear for Greeter {
    async fn init(&self, _ctx: &GearCtx) -> toolkit::Result<()> {
        Ok(())
    }
}

#[derive(Serialize)]
struct Hello {
    message: &'static str,
}

async fn hello() -> Json<Hello> {
    Json(Hello { message: "Hello from a gear written five minutes ago" })
}

impl RestApiCapability for Greeter {
    fn register_rest(
        &self,
        _ctx: &GearCtx,
        router: axum::Router,
        openapi: &dyn OpenApiRegistry,
    ) -> toolkit::Result<axum::Router> {
        Ok(OperationBuilder::<Missing, Missing, ()>::get("/greeter/v1/hello")
            .operation_id("greeter.hello")
            .summary("Say hello")
            .anonymous()
            .handler(hello)
            .json_response(StatusCode::OK, "Greeting")
            .register(router, openapi))
    }
}
