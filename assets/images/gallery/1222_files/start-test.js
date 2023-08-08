window.addEventListener("load", async function () {
  if (proctoringRequired) {
    if (proctorSettings?.track?.recordSession && testType !== "soc-test") {
      proctorSettings["track"]["recordSession"] = false;
    }
    const proctorSettingsUpdated = proctorSettings;
    const apSettings = {
      testAttemptId: testAttemptLabel,
      trackingOptions: proctorSettingsUpdated["track"],
      restrictConsole: false,
      testContainerId: "ap-test-container", // This element was required only if fullscreen is enabled
      evidencePushInterval: evidenceCollectionWindow,
      informUser: proctorSettingsUpdated["inform"],
      domain: domain,
      tenant: false,
      showHowToVideo: true,
    };
    if (testDuration) {
      apSettings["testDuration"] = testDuration;
    }

    if (typeof initAutoProctor === "undefined") {
      alert("There was an error connecting to the internet. We will now try reloading the page.");
      window.location.reload();
      return;
    }

    try {
      const autoProctorTest = await initAutoProctor(apSettings);
      autoProctorTest.start();
    } catch (err) {
      console.log("err", err);
      await apSwal
        .fire({
          title: "Error loading page",
          showCloseButton: true,
          html: "There was an error loading the page. Please click here to reload the page",
          iconHtml: statusIcon("error"),
        })
        .then((value) => {
          window.location.reload();
        });
      throw new Error(err);
    }
  } else if (testType !== "soc-test") {
    startTest();
  }
});

if (testType == "soc-test" && !proctoringRequired) {
  window.addEventListener("load", () => {
    startTest();
  });
}

window.addEventListener("apProgressUpdate", (e) => {
  const action = e.detail;
  if (action === "show") {
    $loaderDownload.hide();
    $loaderBox.show();
  } else if (action === "hide") {
    $loaderBox.hide();
    $loaderDownload.hide();
    $("#loader-container").hide();
  }
  incrementSetupProgBar();
});

function incrementSetupProgBar() {
  const currentVal = parseInt($setupProgressBar.val());
  const newVal = currentVal + 1;
  $setupProgressBar.val(newVal);
  $("span#setup-progress-count").text(newVal);
}

window.addEventListener("apStartTest", () => {
  $proctorFeedback.show();
  startTest();
});

function startTest() {
  try {
    disableChat();
  } catch (e) {}

  if (!proctoringRequired) {
    if (testType === "soc-test") {
      $timerFeedbackContainer.hide();
    }

    $.ajaxSetup({
      beforeSend: function (xhr, settings) {
        xhr.setRequestHeader("Authorization", apTestStartedClientjwt);
      },
    });

    const testStartTime = new Date();

    const dataDict = {
      testAttemptID: testAttemptId,
      startTime: testStartTime.toISOString(),
      tenant: false,
    };

    if (typeof makePostRequestWithRetry === "function") {
      makePostRequestWithRetry(testStartedOnClientUrl, dataDict, null);
    }
  }

  if (testType == "soc-test") {
    $socMainContainer.show();
    $socMainContainer.css("visibility", "visible");
    const domain = socApiUrl;
    const options = {
      ui: { showSidebar: false, navbar: { show: false } },
      type: "quiz",
      comp: "content",
      id: quizId,
      lookupKey: testAttemptId,
      config: { default_page_title: "AutoProctor: Socratease Quiz", api_host: domain, development: development },
    };
    const hmacPayload = hmacPayloadString;

    if (typeof Socratease === "undefined") {
      alert("There was an error connecting to the internet. We will now try reloading the page.");
      window.location.reload();
      return;
    }

    Socratease.init(clientId, jsonPayload, hmacPayload, options);

    if (testType == "soc-test") {
      Socratease.callback = (type, args, func, jwt) => {
        if (type === "unit.submitted") {
          document.getElementById("ap-test-container").setAttribute("class", "");
          userId = args[1]["userId"] ? args[1]["userId"] : args[0]["data"]["userId"];
          attemptNumber = args[0]["data"]["attemptNum"];

          const startedAt = args[0]["data"]["startedAt"];
          const finishedAt = args[0]["data"]["finishedAt"];
          const testAutomaticallySubmitted = args[1].testAutomaticallySubmitted;
          const dataDict = {
            testAttemptLabel: testAttemptLabel,
            userClickedClose: true,
            startedAt: startedAt,
            finishedAt: finishedAt,
            autoClose: testAutomaticallySubmitted,
            tenant: false,
          };

          executeSubmitProcess(dataDict);
        } else {
          func(...args);
        }
      };

      Socratease.onReady = () => {
        if (timerEnabled && testDuration && testDuration > 0) {
          runTestTimer(testDuration);
          typeof $timerContainer !== "undefined" && $timerContainer.show();
          addTimerEventListeners();
        }
        if (proctoringRequired) {
          let checkSocHeaderElemInterval = setInterval(() => {
            if ($(".soc-con-quiz-header__title").length) {
              clearInterval(checkSocHeaderElemInterval);
              $proctorFeedback.insertAfter($(".soc-con-quiz-header__title"));
              $proctorFeedback.show();
            }
          }, 200);
        }
      };
    }
  } else {
    if (timerEnabled && testDuration && testDuration > 0) {
      runTestTimer(testDuration);
      typeof $timerContainer !== "undefined" && $timerContainer.show();
      addTimerEventListeners();
    }
  }
  $("#ap-test-container").show();
}

function handleBeforeUnloadChange(e) {
  e.preventDefault();
  e.returnValue = "Submit answer before closing the tab";
}

let errorResponseOnSubmitObj = { retryDone: false, retryInit: false };

function handleAfterResponse(testAttemptLabel) {
  typeof $googleFormIframeContainer !== "undefined" && $googleFormIframeContainer.remove();
  if (timerInterval) {
    clearInterval(timerInterval);
  }
  $timerFeedbackContainer.remove();

  window.removeEventListener("beforeunload", handleBeforeUnloadChange);

  if (testDetails.label === "ssnrec") {
    window.location.href = `/tests/test-attempts/${testAttemptId}/session-recording?soc_user_id=${userId}&attempt_num=${attemptNumber}&quiz_id=${quizId}&test_label=${testDetails.label}`
  } else {
    window.location.href = socTestSummaryUrl
      ? `${testFinishPageUrl}?soc_user_id=${userId}&test_attempt_id=${testAttemptId}&attempt_num=${attemptNumber}&quiz_id=${quizId}`
      : testFinishPageUrl;
  }
}

const RETRY_WAIT_EC = [5 * 1000, 10 * 1000, 15 * 1000];
let retryCount = 0;
let retryTimeout = null;
let uploadEvidenceCollectionStatus = "init";

function showLeavePageSwal() {
  if (showTestReport) {
    typeof $googleFormIframeContainer !== "undefined" && $googleFormIframeContainer.remove();
  }
  if (timerInterval) {
    clearInterval(timerInterval);
  }
  $timerFeedbackContainer.remove();

  window.removeEventListener("beforeunload", handleBeforeUnloadChange);

  $("video").hide();
  $("canvas").hide();
  apSwal.fire({
    title: "Test Completed",
    html: "<p>You may now close this tab.</p>",
    allowOutsideClick: false,
    showConfirmButton: false,
    iconHtml: statusIcon("success")
  });
}

function executeSubmitProcess(data = null) {
  document.getElementById("ap-test-container").setAttribute("class", "");
  if (timerInterval) {
    clearInterval(timerInterval);
  }
  let dataDict = data ?? {};
  if (!data) {
    dataDict = {
      testAttemptLabel: testAttemptLabel,
      userClickedClose: true,
      tenant: false,
    };
    if (proctoringRequired) {
      dataDict.misc_data = {
        numViolationsThresholdBreachedEvents: autoProctorInstance.getNumViolationsThresholdBreachedEvents(),
      };
    }
  }

  $submitBtn.css("pointer-events", "none");
  $submitBtn.css("opacity", ".5");
  const successCallback = () => {
    uploadEvidenceCollectionStatus = "success";
    if (typeof makePostRequestWithRetry === "function") {
      makePostRequestWithRetry(testSubmitUrl, dataDict, {
        successCallback: () => {
          handleAfterResponse(testAttemptLabel);
        },
      });
    }

    let responseTrackInterval = setInterval(() => {
      if (errorResponseOnSubmitObj.retryInit) {
        console.log("retry initiated");
      }
      if (errorResponseOnSubmitObj.retryDone) {
        $submitBtn.text("Click After Submitting Test");
        $submitBtn.css("pointer-events", "all");
        errorResponseOnSubmitObj = { retryDone: false, retryInit: false };
        clearInterval(responseTrackInterval);
        apSwal
          .fire({
            title: "Something Went Wrong",
            html: "<p>Unfortunately, the submission wasn't successful. Do you want to try again?</p>",
            showCancelButton: true,
            confirmButtonText: "Yes",
            cancelButtonText: "No",
            allowOutsideClick: false,
            iconHtml: statusIcon("error"),
            onOpen: function () {
              Swal.disableButtons();
              setTimeout(Swal.enableButtons, clickTimeout);
            },
          })
          .then((result) => {
            if (result.value) {
              executeSubmitProcess();
            } else {
              showLeavePageSwal();
            }
          });
      }
    }, 1000);
  };
  //this will be called if upload-evidence-collection fails
  const errorCallback = () => {
    uploadEvidenceCollectionStatus = "error";
    if (retryCount === 3) {
      retryCount = 0;
      clearTimeout(retryTimeout);
      $submitBtn.text("Click After Submitting Test");
      $submitBtn.css("pointer-events", "all");
      apSwal
        .fire({
          title: "Something Went Wrong",
          html: "<p>Unfortunately, the submission wasn't successful. Do you want to try again?</p>",
          showCancelButton: true,
          confirmButtonText: "Yes",
          cancelButtonText: "No",
          allowOutsideClick: false,
          iconHtml: statusIcon("error"),
          onOpen: function () {
            Swal.disableButtons();
            setTimeout(Swal.enableButtons, clickTimeout);
          },
        })
        .then((result) => {
          if (result.value) {
            executeSubmitProcess();
          } else {
            showLeavePageSwal();
          }
        });
    } else {
      retryTimeout = setTimeout(() => {
        clearTimeout(retryTimeout);
        executeSubmitProcess();
      }, RETRY_WAIT_EC[retryCount]);
      retryCount++;
    }
  };
  if (autoProctorInstance) {
    if (uploadEvidenceCollectionStatus === "error" || uploadEvidenceCollectionStatus === "init") {
      autoProctorInstance.stopMonitoring(testAttemptId, true, successCallback, errorCallback);
    } else {
      successCallback();
    }
  } else {
    successCallback();
  }
}

$submitBtn.click(() => {
  let buttonClickTimeoutForExit = null;
  apSwal
    .fire({
      title: "Finished clicking Submit button?",
      html:
        "<p>Have you clicked on the Submit button at the bottom of the test?</p>" +
        "<p>If not, do that first and then click this button again.</p>",
      showCancelButton: true,
      confirmButtonText: "Yes, have finished Submitting",
      cancelButtonText: "No, haven't finished Submitting",
      allowOutsideClick: true,
      iconHtml: statusIcon("info"),
      onOpen: function () {
        Swal.disableButtons();
        setTimeout(Swal.enableButtons, clickTimeout);
      },
    })
    .then((result) => {
      if (result.value) {
        if (proctoringRequired && proctorSettings?.["forceFullScreen"]) {
          clearTimeout(buttonClickTimeoutForExit);
          autoProctorInstance.resetFullScreenInterval();
        }
        executeSubmitProcess();
      } else {
        if (proctoringRequired && proctorSettings?.["forceFullScreen"]) {
          clearTimeout(buttonClickTimeoutForExit);
          document.getElementById("ap-test-container").requestFullscreen();
          autoProctorInstance.initFullScreenTrack();
        }
      }
    });
});

if (typeof $timer !== "undefined") {
  $timer.click(() => {
    $("span#base-timer-label").toggle();
  });
}
if (typeof $googleFormIframe !== "undefined") {
  $googleFormIframe.on("load", function () {
    $("html,body").animate({ scrollTop: 0 }, "slow");
  });
}

// calling js sdk function
$("span.calibration-vid-instructions__nav-btn").click(function () {
  if ($(this).hasClass("clickable")) {
    const elemID = $(this).attr("id");
    if (elemID === "calibration-vid-instructions__nav-btn--next") {
      changeCalibrationNavText(true);
    } else if (elemID === "calibration-vid-instructions__nav-btn--prev") {
      changeCalibrationNavText(false);
    }
  }
});

let userWarnedAboutNotSubmitting = false;

if (timerEnabled && testDuration && testDuration > 0) {
  function autoCloseTestAfterCountdownEnd() {
    if (testType != "soc-test") {
      typeof $googleFormIframeContainer !== "undefined" && $googleFormIframeContainer.remove();
      apSwal.fire({
        title: "Time's Up!",
        html:
          "Your time has ended. You cannot answer any more questions. You may now close this window. " +
          "The test creator will get a report of this test.",
        allowOutsideClick: false,
        showConfirmButton: false,
        iconHtml: statusIcon("info"),
      });
      $timerFeedbackContainer.remove();
    } else {
      $socMainContainer.remove();
    }
  }

  function addTimerEventListeners() {
    window.addEventListener("testCountdownAlertThresholdReached", () => {
      userWarnedAboutNotSubmitting = true;
      if (autoCloseTest) {
        if (testType == "soc-test") {
          apSwal.fire({
            title: "Time's Almost Up!",
            html: "Your time has almost ended. The test will be submitted automatically when your time is up.",
            iconHtml: statusIcon("warning"),
          });
        } else {
          apSwal.fire({ 
            title: "Time's Almost Up!",
            html: "Submit the test now. You cannot submit the test after your time is up!",
            iconHtml: statusIcon("warning"),
          });
        }
      } else {
        if (testType == "soc-test") {
          apSwal.fire({
            title: "Time's Almost Up!",
            html: "Your time has almost ended. Click on the Submit button at the bottom to submit your test!",
            iconHtml: statusIcon("warning"),
          });
        } else {
          apSwal.fire({
            title: "Time's Almost Up!",
            html: "Your time has almost ended. Click on the purple Submit button at the bottom to submit your test!",
            iconHtml: statusIcon("warning"),
          });
        }
      }
    });

    window.addEventListener("testCountdownEnd", () => {
      if (autoCloseTest) {
        setTimeout(autoCloseTestAfterCountdownEnd, 5000);
        if (autoProctorInstance) {
          autoProctorInstance.stopMonitoring(testAttemptId);
        }
        window.removeEventListener("beforeunload", handleBeforeUnloadChange);

        if (testType != "soc-test") {
          const dataDict = { testAttemptLabel: testAttemptLabel, autoClose: true, tenant: false };
          if (typeof makePostRequestWithRetry === "function") {
            makePostRequestWithRetry(testSubmitUrl, dataDict, null);
          }
        }
      }
    });
  }

  function runTestTimer(testDuration) {
    const TIME_LIMIT = testDuration;
    const WARNING_THRESHOLD = Math.max(parseInt(0.2 * TIME_LIMIT), 10);
    const ALERT_THRESHOLD = Math.max(parseInt(0.1 * TIME_LIMIT), 10);

    const COLOR_CODES = {
      info: {
        color: "text-green-600",
      },
      warning: {
        color: "text-yellow-800",
        threshold: WARNING_THRESHOLD,
      },
      alert: {
        color: "text-red-600",
        threshold: ALERT_THRESHOLD,
      },
    };

    let timePassed = 0;
    let timeLeft = TIME_LIMIT;
    let remainingPathColor = COLOR_CODES.info.color;

    $("path#base-timer-path-remaining").addClass(remainingPathColor);

    startTimer(TIME_LIMIT);

    function startTimer(timeLimit) {
      timerInterval = setInterval(() => {
        timePassed = timePassed += 1;
        timeLeft = timeLimit - timePassed;
        document.getElementById("base-timer-label").innerHTML = formatTime(timeLeft);
        setRemainingPathColor(timeLeft);
        if (timeLeft === 0) {
          onTimesUp();
        }
      }, 1000);
    }

    function onTimesUp() {
      clearInterval(timerInterval);
      const event = new CustomEvent("testCountdownEnd");
      window.dispatchEvent(event);
    }

    function formatTime(time) {
      const minutes = Math.floor(time / 60);
      let seconds = time % 60;

      if (seconds < 10) {
        seconds = `0${seconds}`;
      }

      return `${minutes}:${seconds}`;
    }

    function setRemainingPathColor(timeLeft) {
      const { alert, warning, info } = COLOR_CODES;
      const baseTimerLabelEle = document.getElementById("base-timer-label");
      if (timeLeft <= alert.threshold) {
        if (!userWarnedAboutNotSubmitting) {
          const event = new CustomEvent("testCountdownAlertThresholdReached");
          window.dispatchEvent(event);
        }
        baseTimerLabelEle.classList.remove(warning.color);
        baseTimerLabelEle.classList.add(alert.color);
      } else if (timeLeft <= warning.threshold) {
        baseTimerLabelEle.classList.remove(info.color);
        baseTimerLabelEle.classList.add(warning.color);
      }
    }
  }

  function clearProctorFeedback(timeInterval) {
    setTimeout(function () {
      $proctorFeedback.html("");
    }, timeInterval);
  }
}

if (!proctoringRequired) {
  // below function is to show a swal to refresh the page etc. This is an ap sdk function which gets invoked in case of errors.
  // This is to inform user to refresh in case of non proctored test As we don't perform any action in case of proctored test for this.
  function catchUpdateStatus(code, msg, details, alertUser, alertUserDetails) {
    if (alertUser) {
      if (alertUserDetails) {
        apSwal.fire(alertUserDetails);
      } else {
        apSwal.fire({
          title: "Error Loading Page",
          html:
            "<p>There was an error loading the page. You could try:</p><ul>" +
            "<li>Opening this link in Incognito Mode (Chrome) or Private Window (Firefox/Chrome) </li>" +
            "<li>Changing your browser</li>" +
            "<li>Changing your device</li>" +
            "</ul>",
          iconHtml: statusIcon("error"),
        });
      }
    }
  }
}
