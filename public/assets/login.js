document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = document.getElementById("err");
  err.textContent = "";
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Gancho": "1" },
    body: JSON.stringify({ usuario: document.getElementById("usuario").value, clave: document.getElementById("clave").value }),
  });
  if (res.ok) return (location.href = "/");
  const body = await res.json().catch(() => ({}));
  err.textContent = body.error || "No se pudo entrar.";
});
