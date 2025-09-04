const form = document.getElementById("leadForm");
const msg = document.getElementById("msg");

form.addEventListener("submit", async (e) => {
  e.preventDefault(); // voorkomt dat alles in de URL komt

  const data = {
    fullName: form.fullName.value.trim(),
    email: form.email.value.trim(),
    phone: form.phone.value.trim() || null,
    notes: form.notes.value.trim() || null,
    consent: form.consent.checked,
    source: form.source.value
  };

  try {
    const res = await fetch("/leads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    });

    const json = await res.json();

    if (!res.ok) {
      msg.textContent = "Fout: " + (json.error || res.statusText);
      msg.className = "error";
    } else {
      msg.textContent = "Lead succesvol opgeslagen! ID: " + json.lead.id;
      msg.className = "success";
      form.reset();
    }
  } catch (err) {
    msg.textContent = "Kon niet opslaan: " + err.message;
    msg.className = "error";
  }
});
