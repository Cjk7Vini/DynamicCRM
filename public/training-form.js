(function() {
    var pageLoadTime = new Date();
    document.getElementById('testDate').value = pageLoadTime.toISOString().split('T')[0];
    document.getElementById('testTime').value = pageLoadTime.toTimeString().slice(0,5);

    function getPracticeCodeFromURL() {
        var urlParams = new URLSearchParams(window.location.search);
        return urlParams.get('p') || urlParams.get('s') || null;
    }

    function loadPractices() {
        var urlPracticeCode = getPracticeCodeFromURL();
        
        if (!urlPracticeCode) {
            var errorHtml = '<div style="background:#fee2e2;border:2px solid #ef4444;border-radius:12px;padding:20px;text-align:center">' +
                '<div style="font-size:48px;margin-bottom:16px">🚫</div>' +
                '<h3 style="color:#991b1b;margin-bottom:12px">Geen toegang</h3>' +
                '<p style="color:#7f1d1d">Deze pagina is alleen toegankelijk via een unieke praktijklink.</p></div>';
            document.getElementById('practiceSection').innerHTML = errorHtml;
            document.getElementById('trainingForm').style.pointerEvents = 'none';
            document.getElementById('trainingForm').style.opacity = '0.5';
            return;
        }
        
        fetch('/api/practices')
            .then(function(r) { return r.json(); })
            .then(function(practices) {
                var practice = practices.find(function(p) { return p.code === urlPracticeCode; });
                if (practice) {
                    document.getElementById('practiceDisplay').value = practice.naam + ' (' + practice.code + ')';
                    document.getElementById('practiceCode').value = practice.code;
                } else {
                    document.getElementById('practiceDisplay').value = 'Onbekend: ' + urlPracticeCode;
                    document.getElementById('practiceCode').value = urlPracticeCode;
                }
            })
            .catch(function() {
                document.getElementById('practiceDisplay').value = 'Praktijk ' + urlPracticeCode;
                document.getElementById('practiceCode').value = urlPracticeCode;
            });
    }

    loadPractices();

    var testConfigs = {
        bia: { fields: [
            { name: 'gewicht', label: 'Gewicht', unit: 'kg' },
            { name: 'lengte', label: 'Lengte', unit: 'cm' },
            { name: 'vetpercentage', label: 'Vetpercentage', unit: '%' },
            { name: 'spiermassa', label: 'Spiermassa', unit: 'kg' },
            { name: 'basale_stofwisseling', label: 'Basale Stofwisseling', unit: 'kcal' }
        ]},
        handgrip: { fields: [
            { name: 'links', label: 'Links', unit: 'kg' },
            { name: 'rechts', label: 'Rechts', unit: 'kg' }
        ]},
        chair_stand: { fields: [{ name: 'herhalingen', label: 'Aantal herhalingen', unit: 'x' }]},
        arm_curl: { fields: [{ name: 'herhalingen', label: 'Aantal herhalingen', unit: 'x' }]},
        one_leg_stand: { fields: [{ name: 'tijd', label: 'Tijd volgehouden', unit: 'sec' }]},
        sit_reach: { fields: [{ name: 'afstand', label: 'Afstand', unit: 'cm' }]},
        shoulder_mobility: { fields: [{ name: 'afstand', label: 'Afstand', unit: 'cm' }]},
        walk_6min: { fields: [{ name: 'afstand', label: 'Afstand', unit: 'm' }]},
        step_2min: { fields: [{ name: 'herhalingen', label: 'Aantal herhalingen', unit: 'x' }]}
    };

    var savedTests = {};
    var allTests = ['bia','handgrip','chair_stand','arm_curl','one_leg_stand','sit_reach','shoulder_mobility','walk_6min','step_2min'];
    var currentTestIndex = -1;
    var testCards = document.querySelectorAll('.test-card');
    var resultSectionsContainer = document.getElementById('resultSections');
    var submitBtn = document.getElementById('submitBtn');
    var testSummary = document.getElementById('testSummary');
    var summaryContent = document.getElementById('summaryContent');

    testCards.forEach(function(card) {
        card.addEventListener('click', function() {
            var testType = this.getAttribute('data-test');
            currentTestIndex = allTests.indexOf(testType);
            testCards.forEach(function(c) { c.classList.remove('active'); });
            card.classList.add('active');
            generateResultFields(testType);
            setTimeout(function() {
                resultSectionsContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 100);
        });
    });

    function getTestName(t) {
        var names = {bia:'BIA',handgrip:'Handknijpkracht',chair_stand:'30-sec Chair Stand',arm_curl:'Arm Curl',one_leg_stand:'Eén-been-stand',sit_reach:'Sit & Reach',shoulder_mobility:'Schoudermobiliteit',walk_6min:'6-Min Wandeltest',step_2min:'2-Min Step-test'};
        return names[t] || t;
    }

    function generateResultFields(testType) {
        var config = testConfigs[testType];
        var html = '<div class="result-section active"><h3 style="color:#667eea;margin-bottom:15px">📝 ' + getTestName(testType) + '</h3>';
        config.fields.forEach(function(field) {
            var savedValue = (savedTests[testType] && savedTests[testType][field.name]) || '';
            html += '<div class="form-group"><label>' + field.label + ' <span class="required">*</span></label>';
            html += '<div class="input-with-unit"><input type="number" id="' + testType + '_' + field.name + '" step="0.1" value="' + savedValue + '" required>';
            html += '<span class="unit-label">' + field.unit + '</span></div></div>';
        });
        html += '<button type="button" class="btn-secondary" onclick="saveCurrentTest(\'' + testType + '\')">✓ ' + getTestName(testType) + ' Opslaan</button></div>';
        resultSectionsContainer.innerHTML = html;
        var firstInput = resultSectionsContainer.querySelector('input');
        if (firstInput) firstInput.focus();
    }

    window.saveCurrentTest = function(testType) {
        var config = testConfigs[testType];
        var testData = {};
        var allFilled = true;
        config.fields.forEach(function(field) {
            var input = document.getElementById(testType + '_' + field.name);
            if (input && input.value) {
                testData[field.name] = input.value;
            } else {
                allFilled = false;
            }
        });
        if (!allFilled) { alert('Vul alle velden in'); return; }
        savedTests[testType] = testData;
        var card = document.querySelector('[data-test="' + testType + '"]');
        if (card) {
            card.classList.remove('active');
            card.classList.add('completed');
            if (!card.querySelector('.checkmark')) {
                var checkmark = document.createElement('span');
                checkmark.className = 'checkmark';
                checkmark.textContent = '✓';
                card.insertBefore(checkmark, card.firstChild);
            }
        }
        updateSummary();
        currentTestIndex++;
        if (currentTestIndex < allTests.length) {
            var nextTestType = allTests[currentTestIndex];
            var nextCard = document.querySelector('[data-test="' + nextTestType + '"]');
            testCards.forEach(function(c) { c.classList.remove('active'); });
            if (nextCard) nextCard.classList.add('active');
            generateResultFields(nextTestType);
            setTimeout(function() {
                var firstInput = resultSectionsContainer.querySelector('input[type="number"]');
                if (firstInput) {
                    firstInput.focus();
                    firstInput.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }
            }, 100);
        } else {
            showCompletionScreen();
        }
    };

    function showCompletionScreen() {
        resultSectionsContainer.innerHTML = '<div style="background:#f0fdf4;border:2px solid #10b981;border-radius:16px;padding:30px;text-align:center"><div style="font-size:64px">🎉</div><h2 style="color:#065f46">Alle tests voltooid!</h2><p style="color:#047857">Je hebt ' + Object.keys(savedTests).length + ' tests ingevuld.</p></div>';
        testCards.forEach(function(c) { c.classList.remove('active'); });
        submitBtn.style.display = 'block';
        submitBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function updateSummary() {
        if (Object.keys(savedTests).length === 0) {
            testSummary.style.display = 'none';
            return;
        }
        testSummary.style.display = 'block';
        var html = '';
        for (var testType in savedTests) {
            html += '<div class="test-summary-item"><strong>' + getTestName(testType) + ':</strong> ' + Object.keys(savedTests[testType]).length + ' metingen</div>';
        }
        summaryContent.innerHTML = html;
    }

    document.getElementById('trainingForm').addEventListener('submit', function(e) {
        e.preventDefault();
        if (Object.keys(savedTests).length === 0) { alert('Vul minimaal één test in'); return; }
        var submitBtn = document.getElementById('submitBtn');
        submitBtn.disabled = true;
        submitBtn.textContent = '⏳ Bezig...';
        var baseData = {
            date: document.getElementById('testDate').value,
            time: document.getElementById('testTime').value,
            patientName: document.getElementById('patientName').value,
            birthDate: document.getElementById('birthDate').value,
            gender: document.getElementById('gender').value,
            practiceCode: document.getElementById('practiceCode').value,
            measurementPhase: document.getElementById('measurementPhase').value,
            notes: document.getElementById('notes').value
        };
        var promises = [];
        for (var testType in savedTests) {
            var formData = Object.assign({}, baseData, { testType: testType, results: {} });
            var config = testConfigs[testType];
            config.fields.forEach(function(field) {
                if (savedTests[testType][field.name]) {
                    formData.results[field.name] = { value: savedTests[testType][field.name], unit: field.unit };
                }
            });
            promises.push(fetch('/api/training-results', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(formData)
            }));
        }
        Promise.all(promises).then(function() {
            document.getElementById('successMessage').style.display = 'block';
            document.getElementById('trainingForm').reset();
            savedTests = {};
            testCards.forEach(function(c) {
                c.classList.remove('active', 'completed');
                var checkmark = c.querySelector('.checkmark');
                if (checkmark) checkmark.remove();
            });
            resultSectionsContainer.innerHTML = '';
            testSummary.style.display = 'none';
            submitBtn.style.display = 'none';
            submitBtn.disabled = false;
            submitBtn.textContent = '💾 Alle Tests Opslaan';
        }).catch(function(error) {
            document.getElementById('errorMessage').textContent = '❌ ' + error.message;
            document.getElementById('errorMessage').style.display = 'block';
            submitBtn.disabled = false;
            submitBtn.textContent = '💾 Alle Tests Opslaan';
        });
    });
})();