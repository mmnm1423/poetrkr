document.addEventListener('DOMContentLoaded', function() {
    // DOM 요소 가져오기
    const botNameInput = document.getElementById('bot-name');
    const apiKeysFileInput = document.getElementById('api-keys-file');
    const apiKeysInfo = document.getElementById('api-keys-info');
    const startKeySelect = document.getElementById('start-key');
    const textFileInput = document.getElementById('text-file');
    const textInfo = document.getElementById('text-info');
    const maxCharsInput = document.getElementById('max-chars');
    const submitBtn = document.getElementById('submit-btn');
    const consoleOutput = document.getElementById('console-output');
    const progressList = document.getElementById('progress-list');
    const outputText = document.getElementById('output-text');
    const copyBtn = document.getElementById('copy-btn');

    // 변수 초기화
    let apiKeys = [];
    let textContent = '';

    // API 키 파일 처리
    apiKeysFileInput.addEventListener('change', function(e) {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = function(e) {
            const content = e.target.result;

            // API 키 파싱 - 첫 번째 공백으로 이름과 키 구분
            apiKeys = content.split('\n')
                .map(line => line.trim())
                .filter(line => line.length > 0)
                .map(line => {
                    const firstSpaceIndex = line.indexOf(' ');
                    if (firstSpaceIndex === -1) return null;

                    const name = line.substring(0, firstSpaceIndex);
                    const key = line.substring(firstSpaceIndex + 1);

                    if (!name || !key) return null;
                    return { name, key };
                })
                .filter(item => item !== null);

            apiKeysInfo.textContent = `${apiKeys.length}개의 API 키를 감지했습니다.`;

            // 드롭다운 업데이트
            startKeySelect.innerHTML = '<option value="">API 키를 선택하세요</option>';

            if (apiKeys.length > 0) {
                for (let i = 0; i < apiKeys.length; i++) {
                    const option = document.createElement('option');
                    option.value = apiKeys[i].name;
                    option.textContent = `${i+1}. ${apiKeys[i].name}`;
                    startKeySelect.appendChild(option);
                }
            }

            startKeySelect.disabled = apiKeys.length === 0;
            checkSubmitButton();
        };

        reader.readAsText(file);
    });

    // 텍스트 파일 처리
    textFileInput.addEventListener('change', function(e) {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = function(e) {
            textContent = e.target.result;
            textInfo.textContent = `총 ${textContent.length}자의 텍스트가 로드되었습니다.`;
            checkSubmitButton();
        };

        reader.readAsText(file);
    });

    // 제출 버튼 활성화 여부 확인
    function checkSubmitButton() {
        submitBtn.disabled = !(apiKeys.length > 0 && textContent.length > 0 && startKeySelect.value);
    }

    // 시작 키 선택 이벤트 추가
    startKeySelect.addEventListener('change', checkSubmitButton);

    // 제출 처리
    submitBtn.addEventListener('click', function() {
        // 콘솔 및 결과 초기화
        consoleOutput.innerHTML = '';
        progressList.innerHTML = '';
        outputText.innerHTML = '';
        copyBtn.disabled = true;

        // 요청 데이터 준비
        const requestData = {
            bot_name: botNameInput.value,
            api_keys: apiKeys,
            selected_key: startKeySelect.value,
            text: textContent,
            max_chars: parseInt(maxCharsInput.value)
        };

        // 서버로 요청 보내기
        fetch('/process', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestData)
        })
        .then(response => response.json())
        .then(data => {
            addConsoleMessage(`처리가 시작되었습니다. ${data.thread_count}개의 요청을 처리합니다.`);
            // 진행 상황 폴링 시작
            pollProgress();
        })
        .catch(error => {
            addConsoleMessage(`오류 발생: ${error}`);
        });
    });

    // 진행 상황 폴링
    function pollProgress() {
        fetch('/progress')
            .then(response => response.json())
            .then(data => {
                // 메시지 업데이트
                if (data.messages && data.messages.length > 0) {
                    // 현재 콘솔에 표시된 메시지 수 확인
                    const currentMsgCount = consoleOutput.childElementCount;

                    // 새 메시지만 추가
                    for (let i = currentMsgCount; i < data.messages.length; i++) {
                        addConsoleMessage(data.messages[i]);
                    }
                }

                // 진행 상황 업데이트
                updateProgressList(data);

                // 모든 작업이 완료되었는지 확인
                if (data.completed < data.total) {
                    // 1초 후 다시 폴링
                    setTimeout(pollProgress, 1000);
                } else if (data.completed > 0 && data.total > 0) {
                    // 결과 가져오기
                    fetchResults();
                    addConsoleMessage(`${data.total}개의 조각 중 ${data.completed}개의 응답을 받았습니다.`);
                }
            })
            .catch(error => {
                addConsoleMessage(`진행 상황 업데이트 오류: ${error}`);
                // 오류 발생 시에도 계속 폴링
                setTimeout(pollProgress, 1000);
            });
    }

    // 간소화된 진행 상황 표시 함수
    function updateProgressList(data) {
        const progressData = data.response_progress || {};

        // 첫 번째 진행 상황이 오면 초기 텍스트 제거
        if (Object.keys(progressData).length > 0 && progressList.querySelector('.initial-text')) {
            progressList.innerHTML = '';
        }

        // 각 조각의 진행 상황 처리
        for (const chunkIdx in progressData) {
            const chunkData = progressData[chunkIdx];
            const progressId = `progress-${chunkIdx}`;
            const charCount = chunkData.chars || 0;
            const keyName = chunkData.key_name || '';

            // 이미 항목이 있는지 확인
            let progressItem = document.getElementById(progressId);

            // 없으면 생성
            if (!progressItem) {
                progressItem = document.createElement('div');
                progressItem.id = progressId;
                progressItem.className = 'progress-item';

                progressItem.innerHTML = `
                    <span>조각 ${parseInt(chunkIdx) + 1}</span>
                    <span>${keyName}</span>
                    <span id="chars-${chunkIdx}">${charCount}자</span>
                `;

                // 진행 상황 목록에 추가
                progressList.appendChild(progressItem);
            } else {
                // 문자 수만 업데이트
                const charsLabel = document.getElementById(`chars-${chunkIdx}`);
                if (charsLabel) charsLabel.textContent = `${charCount}자`;
            }

            // 완료된 항목 강조
            if (data.completed > 0 && Object.keys(data.results || {}).includes(chunkIdx)) {
                progressItem.classList.add('completed');
            }
        }
    }

    // 결과 가져오기
    function fetchResults() {
        fetch('/results')
            .then(response => response.json())
            .then(data => {
                if (!data.results) {
                    addConsoleMessage('결과를 받지 못했습니다.');
                    return;
                }

                // 결과 정렬 및 처리 - 인덱스 순서대로 정렬
                const sortedResults = Object.values(data.results)
                    .sort((a, b) => a.index - b.index);

                let allCode = '';
                let processedCount = 0;

                sortedResults.forEach(result => {
                    processedCount++;
                    if (result.error) {
                        addConsoleMessage(`조각 ${result.index + 1} 오류: ${result.error}`);
                    } else {
                        const codeBlock = extractCodeBlocks(result.response);
                        allCode += codeBlock + '\n\n';
                    }
                });

                // 결과 표시
                outputText.textContent = allCode.trim();
                copyBtn.disabled = false;

                addConsoleMessage(`${processedCount}개의 조각 처리가 완료되었습니다.`);
            })
            .catch(error => {
                addConsoleMessage(`결과 가져오기 오류: ${error}`);
            });
    }

    // 코드 블록 추출 함수
    function extractCodeBlocks(text) {
        const regex = /```(?:[a-zA-Z]*\n)?([\s\S]*?)```/g;
        const matches = [];
        let match;

        while ((match = regex.exec(text)) !== null) {
            matches.push(match[1]);
        }

        return matches.join('\n\n');
    }

    // 콘솔 메시지 추가
    function addConsoleMessage(message) {
        // 첫 번째 메시지가 오면 초기 텍스트 제거
        if (consoleOutput.querySelector('.initial-text')) {
            consoleOutput.innerHTML = '';
        }

        const msgElement = document.createElement('div');
        msgElement.textContent = message;
        consoleOutput.appendChild(msgElement);
        // 자동 스크롤
        consoleOutput.scrollTop = consoleOutput.scrollHeight;
    }

    // 복사 버튼
    copyBtn.addEventListener('click', function() {
        const text = outputText.textContent;
        navigator.clipboard.writeText(text)
            .then(() => {
                addConsoleMessage('결과가 클립보드에 복사되었습니다.');
            })
            .catch(err => {
                addConsoleMessage(`복사 실패: ${err}`);
            });
    });
});