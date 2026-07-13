import { runKeyStoreConformance } from "@loom/conformance";
import { InMemoryKeyStore } from "./keystore";

// The reference KeyStore must uphold the erasure contract every backing (KMS/HSM/vault) owes.
runKeyStoreConformance(() => new InMemoryKeyStore(), "InMemoryKeyStore");
