-- Preserve legacy rows; absence of a server verifier is not verified identity.
ALTER TABLE external_account_bindings ADD COLUMN verified_by TEXT CHECK(verified_by IS NULL OR verified_by IN ('email','admin'));
