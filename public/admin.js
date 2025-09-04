// ✅ Toggle wachtwoord zichtbaar/onzichtbaar
document.getElementById("toggle").addEventListener("click", () => {
  const keyInput = document.getElementById("key");
  keyInput.type = keyInput.type === "password" ? "text" : "password";
});

// ✅ Hulpfunctie om param uit URL te lezen
function getQueryParam(name) {
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get(name);
}

// ✅ Helper voor berichten
function showMsg(text, type = "") {
  const msg = document.getElementById("msg");
  msg.textContent = text;
  msg.className = type ? type : "";
}

// ✅ Autofill vanuit URL ?key=...
document.getElementById("autofill").addEventListener("click", () => {
  const paramKey = getQueryParam("key");
  if (paramKey) {
    document.getElementById("key").value = paramKey;
    showMsg("Sleutel ingevuld uit URL.", "success");
  } else {
    showMsg("Geen sleutel in URL gevonden.", "error");
  }
});

// ✅ Laad leads
document.getElementById("load").addEventListener("click", async () => {
  const key = document.getElementById("key").value.trim();
  if (!key) {
    showMsg("Voer eerst een sleutel in!", "error");
    return;
  }

  try {
    const res = await fetch("/api/leads", {
      headers: { "x-admin-key": key }
    });

    const data = await res.json();

    if (!res.ok) {
      showMsg("Fout: " + (data.error || res.statusText), "error");
      return;
    }

    const rows = Array.isArray(data) ? data : [];

    if (rows.length === 0) {
      showMsg("Geen leads gevonden.", "error");
      renderTable([]);
      return;
    }

    renderTable(rows);
    showMsg("Leads geladen (" + rows.length + " gevonden).", "success");

  } catch (e) {
    console.error(e);
    showMsg("Kon data niet laden: " + e.message, "error");
  }
});

// ✅ Render tabel
function renderTable(rows) {
  const thead = document.getElementById("thead");
  const tbody = document.getElementById("tbody");
  thead.innerHTML = "";
  tbody.innerHTML = "";

  if (!rows || rows.length === 0) {
    thead.innerHTML = "<th>Geen resultaten</th>";
    return;
  }

  const keys = Object.keys(rows[0]);
  keys.forEach(k => {
    const th = document.createElement("th");
    th.textContent = k;
    thead.appendChild(th);
  });

  rows.forEach(r => {
    const tr = document.createElement("tr");
    keys.forEach(k => {
      const td = document.createElement("td");
      td.textContent = r[k] ?? "";
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
}

// ✅ Automatisch laden als sleutel in URL staat
window.addEventListener("load", () => {
  const autoKey = getQueryParam("key");
  if (autoKey) {
    document.getElementById("key").value = autoKey;
    document.getElementById("load").click();
  }
});
