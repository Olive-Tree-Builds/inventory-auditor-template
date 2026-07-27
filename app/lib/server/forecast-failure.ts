import { ForecastOutputValidationError } from "./forecast-output";
import { ForecastResearchValidationError } from "./forecast-research";
import { ForecastProviderError } from "./openai-responses-forecast";

export type SafeForecastFailureCode =
  | "ai_configuration_invalid"
  | "forecast_input_invalid"
  | "ai_authentication_failed"
  | "ai_quota_unavailable"
  | "ai_rate_limited"
  | "ai_endpoint_or_model_missing"
  | "ai_provider_unavailable"
  | "ai_request_timed_out"
  | "ai_request_rejected"
  | "ai_web_search_not_used"
  | "ai_structured_output_invalid"
  | "ai_source_validation_failed"
  | "ai_factor_validation_failed"
  | "ai_recommendation_validation_failed"
  | "ai_scope_validation_failed"
  | "ai_audit_validation_failed"
  | "ai_response_validation_failed";

export type SafeForecastFailure = {
  code: SafeForecastFailureCode;
  message: string;
};

function providerFailure(error: ForecastProviderError): SafeForecastFailure {
  if (error.code === "invalid_configuration") {
    return {
      code: "ai_configuration_invalid",
      message: "Live research could not start because the saved AI provider settings are incomplete or incompatible. Reconnect and test the AI provider.",
    };
  }
  if (error.code === "invalid_request") {
    return {
      code: "forecast_input_invalid",
      message: "Live research could not start because the authorized forecast input failed the server safety checks. Review the location details and imported history.",
    };
  }
  if (error.code === "web_search_unavailable") {
    return {
      code: "ai_web_search_not_used",
      message: "Live research was rejected because the selected model did not perform its provider's required web search. Run the AI capability test and confirm that model supports live search.",
    };
  }
  if (error.code === "structured_output_invalid" || error.code === "invalid_response") {
    return {
      code: "ai_structured_output_invalid",
      message: "Live research was rejected because the selected model did not return JSON that passed the app's server-side validator. Run the AI capability test and confirm JSON output support.",
    };
  }
  if (error.code === "quota_unavailable") {
    return {
      code: "ai_quota_unavailable",
      message: "The selected AI project has no usable API quota or billing allowance for this forecast. Check that project's API balance and budget, then run the forecast again.",
    };
  }
  if (error.code === "rate_limited") {
    return {
      code: "ai_rate_limited",
      message: "The AI provider's request or token rate limit was reached. Choose one location for the first test, wait for the limit window to reset, and run the forecast again.",
    };
  }
  if (error.code === "request_timeout") {
    return {
      code: "ai_request_timed_out",
      message: "Live research did not finish within five minutes. Choose one location and a lower-latency compatible model, then run the forecast again.",
    };
  }
  if (error.status === 401 || error.status === 403) {
    return {
      code: "ai_authentication_failed",
      message: "The AI provider rejected the saved credential or model permission. Replace the key or review the account's model access, then test again.",
    };
  }
  if (error.status === 429) {
    return {
      code: "ai_rate_limited",
      message: "The AI provider's request or token rate limit was reached. Choose one location for the first test, wait for the limit window to reset, and run the forecast again.",
    };
  }
  if (error.status === 404) {
    return {
      code: "ai_endpoint_or_model_missing",
      message: "The configured AI endpoint or model was not found. Check the selected provider and exact API model name, then test again.",
    };
  }
  if (error.status === 400 || error.status === 422) {
    return {
      code: "ai_request_rejected",
      message: "The AI provider rejected its live-search or JSON-output request. Run the capability test and choose a compatible model if it fails.",
    };
  }
  return {
    code: "ai_provider_unavailable",
    message: "The AI provider could not complete the live-research request. Check the provider status and internet connection, then run the forecast again.",
  };
}

function validationFailure(error: ForecastOutputValidationError | ForecastResearchValidationError): SafeForecastFailure {
  const issues = error.issues.join("\n");
  if (/source|direct HTTPS|source_ids/i.test(issues)) {
    return {
      code: "ai_source_validation_failed",
      message: "Live research was rejected because its evidence sources were missing, indirect, or not tied to the claimed adjustments. No outside adjustment was applied.",
    };
  }
  if (/assess every active variable|active variable|variable_id|variable does not match|inactive variable|authorized combinations|location\/product\/variable/i.test(issues)) {
    return {
      code: "ai_factor_validation_failed",
      message: "Live research was rejected because it did not assess every active Analysis Skill factor exactly as required. No outside adjustment was applied.",
    };
  }
  if (/scope|workspace|brand|location|policy|provider metadata/i.test(issues)) {
    return {
      code: "ai_scope_validation_failed",
      message: "Live research was rejected because its workspace, brand, location, policy, or provider scope did not exactly match the authorized request.",
    };
  }
  if (/baseline|recommended_quantity|recommendation|quantity|reconcile|adjustment/i.test(issues)) {
    return {
      code: "ai_recommendation_validation_failed",
      message: "Live research was rejected because its product quantities did not reconcile with the server-calculated historical baseline and listed adjustments.",
    };
  }
  if (/data_quality|historical input audit|generated_at|run identifier/i.test(issues)) {
    return {
      code: "ai_audit_validation_failed",
      message: "Live research was rejected because its history or audit record did not match the server-owned forecast inputs.",
    };
  }
  return {
    code: "ai_response_validation_failed",
    message: "Live research returned a result that did not pass the Inventory Auditor safety checks. The historical baseline was preserved without outside adjustments.",
  };
}

/** Convert provider and validation failures into stable, non-sensitive user guidance. */
export function safeForecastFailure(error: unknown): SafeForecastFailure {
  if (error instanceof ForecastProviderError) return providerFailure(error);
  if (error instanceof ForecastOutputValidationError || error instanceof ForecastResearchValidationError) return validationFailure(error);
  return {
    code: "ai_response_validation_failed",
    message: "Live research could not be verified. The historical baseline was preserved without outside adjustments.",
  };
}
