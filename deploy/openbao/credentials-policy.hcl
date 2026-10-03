path "secret/data/openmuse/*" {
  capabilities = ["create", "update", "read"]
}

path "secret/metadata/openmuse/*" {
  capabilities = ["read", "delete"]
}
