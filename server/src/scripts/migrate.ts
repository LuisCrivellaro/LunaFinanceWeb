import { withContext } from "./_cli.js";

// createContext já aplica as migrações pendentes.
await withContext(async () => {
  console.log("Banco atualizado.");
});
