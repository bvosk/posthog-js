import { PostHog } from '../posthog-core'
import {
    Survey,
    SurveyAppearance,
    SurveyPosition,
    SurveyQuestion,
    SurveyQuestionBranchingType,
    SurveyQuestionType,
    SurveyRenderReason,
    SurveySchedule,
    SurveyType,
    SurveyWidgetType,
} from '../posthog-surveys-types'
import { addEventListener } from '../utils'

import * as Preact from 'preact'
import { useContext, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { document as _document, window as _window } from '../utils/globals'
import { doesSurveyUrlMatch, SURVEY_LOGGER as logger } from '../utils/survey-utils'
import { isNull, isNumber } from '../utils/type-utils'
import { createWidgetStyle, retrieveWidgetShadow } from './surveys-widget'
import { ConfirmationMessage } from './surveys/components/ConfirmationMessage'
import { Cancel } from './surveys/components/QuestionHeader'
import {
    LinkQuestion,
    MultipleChoiceQuestion,
    OpenTextQuestion,
    RatingQuestion,
} from './surveys/components/QuestionTypes'
import {
    createShadow,
    defaultSurveyAppearance,
    dismissedSurveyEvent,
    getContrastingTextColor,
    getDisplayOrderQuestions,
    getSurveyResponseKey,
    getSurveySeen,
    hasWaitPeriodPassed,
    sendSurveyEvent,
    style,
    SURVEY_DEFAULT_Z_INDEX,
    SurveyContext,
} from './surveys/surveys-extension-utils'
import { prepareStylesheet } from './utils/stylesheet-loader'

// We cast the types here which is dangerous but protected by the top level generateSurveys call
const window = _window as Window & typeof globalThis
const document = _document as Document

function getPosthogWidgetClass(surveyId: string) {
    return `.PostHogWidget${surveyId}`
}

const DISPATCH_FEEDBACK_WIDGET_EVENT = 'ph:show_survey_widget'

function getRatingBucketForResponseValue(responseValue: number, scale: number) {
    if (scale === 3) {
        if (responseValue < 1 || responseValue > 3) {
            throw new Error('The response must be in range 1-3')
        }

        return responseValue === 1 ? 'negative' : responseValue === 2 ? 'neutral' : 'positive'
    } else if (scale === 5) {
        if (responseValue < 1 || responseValue > 5) {
            throw new Error('The response must be in range 1-5')
        }

        return responseValue <= 2 ? 'negative' : responseValue === 3 ? 'neutral' : 'positive'
    } else if (scale === 7) {
        if (responseValue < 1 || responseValue > 7) {
            throw new Error('The response must be in range 1-7')
        }

        return responseValue <= 3 ? 'negative' : responseValue === 4 ? 'neutral' : 'positive'
    } else if (scale === 10) {
        if (responseValue < 0 || responseValue > 10) {
            throw new Error('The response must be in range 0-10')
        }

        return responseValue <= 6 ? 'detractors' : responseValue <= 8 ? 'passives' : 'promoters'
    }

    throw new Error('The scale must be one of: 3, 5, 7, 10')
}

export function getNextSurveyStep(
    survey: Survey,
    currentQuestionIndex: number,
    response: string | string[] | number | null
) {
    const question = survey.questions[currentQuestionIndex]
    const nextQuestionIndex = currentQuestionIndex + 1

    if (!question.branching?.type) {
        if (currentQuestionIndex === survey.questions.length - 1) {
            return SurveyQuestionBranchingType.End
        }

        return nextQuestionIndex
    }

    if (question.branching.type === SurveyQuestionBranchingType.End) {
        return SurveyQuestionBranchingType.End
    } else if (question.branching.type === SurveyQuestionBranchingType.SpecificQuestion) {
        if (Number.isInteger(question.branching.index)) {
            return question.branching.index
        }
    } else if (question.branching.type === SurveyQuestionBranchingType.ResponseBased) {
        // Single choice
        if (question.type === SurveyQuestionType.SingleChoice) {
            // :KLUDGE: for now, look up the choiceIndex based on the response
            // TODO: once QuestionTypes.MultipleChoiceQuestion is refactored, pass the selected choiceIndex into this method
            const selectedChoiceIndex = question.choices.indexOf(`${response}`)

            if (question.branching?.responseValues?.hasOwnProperty(selectedChoiceIndex)) {
                const nextStep = question.branching.responseValues[selectedChoiceIndex]

                // Specific question
                if (Number.isInteger(nextStep)) {
                    return nextStep
                }

                if (nextStep === SurveyQuestionBranchingType.End) {
                    return SurveyQuestionBranchingType.End
                }

                return nextQuestionIndex
            }
        } else if (question.type === SurveyQuestionType.Rating) {
            if (typeof response !== 'number' || !Number.isInteger(response)) {
                throw new Error('The response type must be an integer')
            }

            const ratingBucket = getRatingBucketForResponseValue(response, question.scale)

            if (question.branching?.responseValues?.hasOwnProperty(ratingBucket)) {
                const nextStep = question.branching.responseValues[ratingBucket]

                // Specific question
                if (Number.isInteger(nextStep)) {
                    return nextStep
                }

                if (nextStep === SurveyQuestionBranchingType.End) {
                    return SurveyQuestionBranchingType.End
                }

                return nextQuestionIndex
            }
        }

        return nextQuestionIndex
    }

    logger.warn('Falling back to next question index due to unexpected branching type')
    return nextQuestionIndex
}

export class SurveyManager {
    private _posthog: PostHog
    private _surveyInFocus: string | null
    private _surveyTimeouts: Map<string, NodeJS.Timeout> = new Map()
    private _widgetSelectorListeners: Map<string, { element: Element; listener: EventListener }> = new Map()

    constructor(posthog: PostHog) {
        this._posthog = posthog
        // This is used to track the survey that is currently in focus. We only show one survey at a time.
        this._surveyInFocus = null
    }

    private _canShowNextEventBasedSurvey = (): boolean => {
        // with event based surveys, we need to show the next survey without reloading the page.
        // A simple check for div elements with the class name pattern of PostHogSurvey_xyz doesn't work here
        // because preact leaves behind the div element for any surveys responded/dismissed with a <style> node.
        // To alleviate this, we check the last div in the dom and see if it has any elements other than a Style node.
        // if the last PostHogSurvey_xyz div has only one style node, we can show the next survey in the queue
        // without reloading the page.
        const surveyPopups = document.querySelectorAll(`div[class^=PostHogSurvey]`)
        if (surveyPopups.length > 0) {
            return surveyPopups[surveyPopups.length - 1].shadowRoot?.childElementCount === 1
        }
        return true
    }

    private _clearSurveyTimeout(surveyId: string) {
        const timeout = this._surveyTimeouts.get(surveyId)
        if (timeout) {
            clearTimeout(timeout)
            this._surveyTimeouts.delete(surveyId)
        }
    }

    private _handlePopoverSurvey = (survey: Survey): void => {
        const surveyWaitPeriodInDays = survey.conditions?.seenSurveyWaitPeriodInDays
        const lastSeenSurveyDate = localStorage.getItem(`lastSeenSurveyDate`)

        if (!hasWaitPeriodPassed(lastSeenSurveyDate, surveyWaitPeriodInDays)) {
            return
        }

        const surveySeen = getSurveySeen(survey)
        if (!surveySeen) {
            this._clearSurveyTimeout(survey.id)
            this._addSurveyToFocus(survey.id)
            const delaySeconds = survey.appearance?.surveyPopupDelaySeconds || 0
            const shadow = createShadow(style(survey?.appearance), survey.id, undefined, this._posthog)
            if (delaySeconds <= 0) {
                return Preact.render(
                    <SurveyPopup
                        key={'popover-survey'}
                        posthog={this._posthog}
                        survey={survey}
                        removeSurveyFromFocus={this._removeSurveyFromFocus}
                        isPopup={true}
                    />,
                    shadow
                )
            }
            const timeoutId = setTimeout(() => {
                if (!doesSurveyUrlMatch(survey)) {
                    return this._removeSurveyFromFocus(survey.id)
                }
                // rendering with surveyPopupDelaySeconds = 0 because we're already handling the timeout here
                Preact.render(
                    <SurveyPopup
                        key={'popover-survey'}
                        posthog={this._posthog}
                        survey={{ ...survey, appearance: { ...survey.appearance, surveyPopupDelaySeconds: 0 } }}
                        removeSurveyFromFocus={this._removeSurveyFromFocus}
                        isPopup={true}
                    />,
                    shadow
                )
            }, delaySeconds * 1000)
            this._surveyTimeouts.set(survey.id, timeoutId)
        }
    }

    private _handleWidget = (survey: Survey): void => {
        // Ensure widget container exists if it doesn't
        const shadow = retrieveWidgetShadow(survey, this._posthog)
        const stylesheetContent = style(survey.appearance)
        const stylesheet = prepareStylesheet(document, stylesheetContent, this._posthog)

        if (stylesheet) {
            shadow.appendChild(stylesheet)
        }

        Preact.render(
            <FeedbackWidget
                key={'feedback-survey-' + survey.id} // Use unique key
                posthog={this._posthog}
                survey={survey}
                removeSurveyFromFocus={this._removeSurveyFromFocus}
            />,
            shadow
        )
    }

    private _removeWidgetSelectorListener = (surveyId: string): void => {
        const existing = this._widgetSelectorListeners.get(surveyId)
        if (existing) {
            existing.element.removeEventListener('click', existing.listener)
            existing.element.removeAttribute('PHWidgetSurveyClickListener')
            this._widgetSelectorListeners.delete(surveyId)
            logger.info(`Removed click listener for survey ${surveyId}`)
        }
    }

    private _manageWidgetSelectorListener = (survey: Survey): void => {
        const selector = survey.appearance?.widgetSelector
        if (!selector) {
            return
        }

        const currentElement = document.querySelector(selector)
        const existingListenerData = this._widgetSelectorListeners.get(survey.id)

        if (!currentElement) {
            // Element not found, remove listener if it exists
            if (existingListenerData) {
                this._removeWidgetSelectorListener(survey.id)
            }
            return
        }

        // Ensure the base widget is rendered first if needed
        this._handleWidget(survey)

        if (existingListenerData) {
            // Listener exists, check if element changed
            if (currentElement !== existingListenerData.element) {
                logger.info(`Selector element changed for survey ${survey.id}. Re-attaching listener.`)
                this._removeWidgetSelectorListener(survey.id)
                // Continue to attach listener to the new element below
            } else {
                // Element is the same, listener already attached, do nothing
                return
            }
        }

        // Element found, and no listener attached (or it was just removed from old element)
        if (!currentElement.hasAttribute('PHWidgetSurveyClickListener')) {
            const listener = (event: Event) => {
                event.stopPropagation() // Prevent bubbling

                if (survey.appearance?.position !== SurveyPosition.NextToTrigger) {
                    window.dispatchEvent(
                        new CustomEvent(DISPATCH_FEEDBACK_WIDGET_EVENT, {
                            detail: { surveyId: survey.id, position: {} },
                        })
                    )
                    return
                }

                const buttonRect = (event.currentTarget as HTMLElement).getBoundingClientRect()
                const viewportHeight = window.innerHeight
                const viewportWidth = window.innerWidth
                const surveyWidth = parseInt(survey.appearance?.maxWidth || '300')
                const estimatedMinSurveyHeight = 250 // Keep this estimation
                const buttonCenterX = buttonRect.left + buttonRect.width / 2
                let left = buttonCenterX - surveyWidth / 2
                const horizontalPadding = 20
                if (left + surveyWidth > viewportWidth - horizontalPadding) {
                    left = viewportWidth - surveyWidth - horizontalPadding
                }
                if (left < horizontalPadding) {
                    left = horizontalPadding
                }
                const spacing = 12
                const spaceBelow = viewportHeight - buttonRect.bottom
                const spaceAbove = buttonRect.top
                const showAbove = spaceBelow < estimatedMinSurveyHeight && spaceAbove > spaceBelow

                const positionStyles: React.CSSProperties = {
                    position: 'fixed',
                    top: showAbove ? 'auto' : `${buttonRect.bottom + spacing}px`,
                    left: `${left}px`,
                    right: 'auto',
                    bottom: showAbove ? `${viewportHeight - buttonRect.top + spacing}px` : 'auto',
                    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
                    borderBottom: `1.5px solid ${survey.appearance?.borderColor || '#c9c6c6'}`,
                    borderRadius: '10px',
                    zIndex: SURVEY_DEFAULT_Z_INDEX,
                }

                // Dispatch event for the FeedbackWidget to catch
                window.dispatchEvent(
                    new CustomEvent(DISPATCH_FEEDBACK_WIDGET_EVENT, {
                        detail: { surveyId: survey.id, position: positionStyles },
                    })
                )
            }

            addEventListener(currentElement, 'click', listener)
            currentElement.setAttribute('PHWidgetSurveyClickListener', 'true')
            this._widgetSelectorListeners.set(survey.id, { element: currentElement, listener })
            logger.info(`Attached click listener for survey ${survey.id}`)
        }
    }

    /**
     * Sorts surveys by their appearance delay in ascending order. If a survey does not have an appearance delay,
     * it is considered to have a delay of 0.
     * @param surveys
     * @returns The surveys sorted by their appearance delay
     */
    private _sortSurveysByAppearanceDelay(surveys: Survey[]): Survey[] {
        return surveys.sort((a, b) => {
            const aIsAlways = a.schedule === SurveySchedule.Always
            const bIsAlways = b.schedule === SurveySchedule.Always

            if (aIsAlways && !bIsAlways) {
                return 1 // a comes after b
            }
            if (!aIsAlways && bIsAlways) {
                return -1 // a comes before b
            }
            // If both are Always or neither is Always, sort by delay
            return (a.appearance?.surveyPopupDelaySeconds || 0) - (b.appearance?.surveyPopupDelaySeconds || 0)
        })
    }

    /**
     * Checks the feature flags associated with this Survey to see if the survey can be rendered.
     * @param survey
     * @param instance
     */
    public canRenderSurvey = (survey: Survey): SurveyRenderReason => {
        const renderReason: SurveyRenderReason = {
            visible: false,
        }

        if (survey.end_date) {
            renderReason.disabledReason = `survey was completed on ${survey.end_date}`
            return renderReason
        }

        if (survey.type != SurveyType.Popover) {
            renderReason.disabledReason = `Only Popover survey types can be rendered`
            return renderReason
        }

        const linkedFlagCheck = survey.linked_flag_key
            ? this._posthog.featureFlags.isFeatureEnabled(survey.linked_flag_key)
            : true

        if (!linkedFlagCheck) {
            renderReason.disabledReason = `linked feature flag ${survey.linked_flag_key} is false`
            return renderReason
        }

        const targetingFlagCheck = survey.targeting_flag_key
            ? this._posthog.featureFlags.isFeatureEnabled(survey.targeting_flag_key)
            : true

        if (!targetingFlagCheck) {
            renderReason.disabledReason = `targeting feature flag ${survey.targeting_flag_key} is false`
            return renderReason
        }

        const internalTargetingFlagCheck = survey.internal_targeting_flag_key
            ? this._posthog.featureFlags.isFeatureEnabled(survey.internal_targeting_flag_key)
            : true

        if (!internalTargetingFlagCheck) {
            renderReason.disabledReason = `internal targeting feature flag ${survey.internal_targeting_flag_key} is false`
            return renderReason
        }

        renderReason.visible = true
        return renderReason
    }

    public renderSurvey = (survey: Survey, selector: Element): void => {
        Preact.render(
            <SurveyPopup
                key={'popover-survey'}
                posthog={this._posthog}
                survey={survey}
                removeSurveyFromFocus={this._removeSurveyFromFocus}
                isPopup={false}
            />,
            selector
        )
    }

    public callSurveysAndEvaluateDisplayLogic = (forceReload: boolean = false): void => {
        this._posthog?.getActiveMatchingSurveys((surveys) => {
            const nonAPISurveys = surveys.filter((survey) => survey.type !== 'api')

            // Create a queue of surveys sorted by their appearance delay.  We will evaluate the display logic
            // for each survey in the queue in order, and only display one survey at a time.
            const nonAPISurveyQueue = this._sortSurveysByAppearanceDelay(nonAPISurveys)

            // Keep track of surveys processed this cycle to remove listeners for inactive ones
            const activeSelectorSurveyIds = new Set<string>()

            nonAPISurveyQueue.forEach((survey) => {
                // Widget Type Logic
                if (survey.type === SurveyType.Widget) {
                    if (survey.appearance?.widgetType === SurveyWidgetType.Tab) {
                        // Render tab widget if not already present
                        this._handleWidget(survey)
                    } else if (
                        survey.appearance?.widgetType === SurveyWidgetType.Selector &&
                        survey.appearance?.widgetSelector
                    ) {
                        activeSelectorSurveyIds.add(survey.id)
                        // Manage the listener attachment/detachment dynamically
                        this._manageWidgetSelectorListener(survey)
                    }
                }

                // Popover Type Logic (only one shown at a time)
                if (
                    isNull(this._surveyInFocus) &&
                    survey.type === SurveyType.Popover &&
                    this._canShowNextEventBasedSurvey()
                ) {
                    this._handlePopoverSurvey(survey)
                }
            })

            // Clean up listeners for surveys that are no longer active or matched
            this._widgetSelectorListeners.forEach((_, surveyId) => {
                if (!activeSelectorSurveyIds.has(surveyId)) {
                    this._removeWidgetSelectorListener(surveyId)
                }
            })
        }, forceReload)
    }

    private _addSurveyToFocus = (id: string): void => {
        if (!isNull(this._surveyInFocus)) {
            logger.error(`Survey ${[...this._surveyInFocus]} already in focus. Cannot add survey ${id}.`)
        }
        this._surveyInFocus = id
    }

    private _removeSurveyFromFocus = (id: string): void => {
        if (this._surveyInFocus !== id) {
            logger.error(`Survey ${id} is not in focus. Cannot remove survey ${id}.`)
        }
        this._clearSurveyTimeout(id)
        this._surveyInFocus = null
    }

    // Expose internal state and methods for testing
    public getTestAPI() {
        return {
            addSurveyToFocus: this._addSurveyToFocus,
            removeSurveyFromFocus: this._removeSurveyFromFocus,
            surveyInFocus: this._surveyInFocus,
            surveyTimeouts: this._surveyTimeouts,
            canShowNextEventBasedSurvey: this._canShowNextEventBasedSurvey,
            handleWidget: this._handleWidget,
            handlePopoverSurvey: this._handlePopoverSurvey,
            manageWidgetSelectorListener: this._manageWidgetSelectorListener,
            sortSurveysByAppearanceDelay: this._sortSurveysByAppearanceDelay,
        }
    }
}

export const renderSurveysPreview = ({
    survey,
    parentElement,
    previewPageIndex,
    forceDisableHtml,
    onPreviewSubmit,
    posthog,
}: {
    survey: Survey
    parentElement: HTMLElement
    previewPageIndex: number
    forceDisableHtml?: boolean
    onPreviewSubmit?: (res: string | string[] | number | null) => void
    posthog?: PostHog
}) => {
    const stylesheetContent = style(survey.appearance)
    const stylesheet = prepareStylesheet(document, stylesheetContent, posthog)

    // Remove previously attached <style>
    Array.from(parentElement.children).forEach((child) => {
        if (child instanceof HTMLStyleElement) {
            parentElement.removeChild(child)
        }
    })

    if (stylesheet) {
        parentElement.appendChild(stylesheet)
    }

    const textColor = getContrastingTextColor(
        survey.appearance?.backgroundColor || defaultSurveyAppearance.backgroundColor || 'white'
    )

    Preact.render(
        <SurveyPopup
            key="surveys-render-preview"
            survey={survey}
            forceDisableHtml={forceDisableHtml}
            style={{
                position: 'relative',
                right: 0,
                borderBottom: `1px solid ${survey.appearance?.borderColor}`,
                borderRadius: 10,
                color: textColor,
            }}
            onPreviewSubmit={onPreviewSubmit}
            previewPageIndex={previewPageIndex}
            removeSurveyFromFocus={() => {}}
            isPopup={true}
        />,
        parentElement
    )
}

export const renderFeedbackWidgetPreview = ({
    survey,
    root,
    forceDisableHtml,
    posthog,
}: {
    survey: Survey
    root: HTMLElement
    forceDisableHtml?: boolean
    posthog?: PostHog
}) => {
    const stylesheetContent = createWidgetStyle(survey.appearance?.widgetColor)
    const stylesheet = prepareStylesheet(document, stylesheetContent, posthog)
    if (stylesheet) {
        root.appendChild(stylesheet)
    }

    Preact.render(
        <FeedbackWidget
            key={'feedback-render-preview'}
            forceDisableHtml={forceDisableHtml}
            survey={survey}
            readOnly={true}
            removeSurveyFromFocus={() => {}}
        />,
        root
    )
}

// This is the main exported function
export function generateSurveys(posthog: PostHog) {
    // NOTE: Important to ensure we never try and run surveys without a window environment
    if (!document || !window) {
        return
    }

    const surveyManager = new SurveyManager(posthog)
    surveyManager.callSurveysAndEvaluateDisplayLogic(true)

    // recalculate surveys every second to check if URL or selectors have changed
    setInterval(() => {
        surveyManager.callSurveysAndEvaluateDisplayLogic(false)
    }, 1000)
    return surveyManager
}

type UseHideSurveyOnURLChangeProps = {
    survey: Pick<Survey, 'id' | 'conditions' | 'type' | 'appearance'>
    removeSurveyFromFocus: (id: string) => void
    setSurveyVisible: (visible: boolean) => void
    isPreviewMode?: boolean
}

/**
 * This hook handles URL-based survey visibility after the initial mount.
 * The initial URL check is handled by the `getActiveMatchingSurveys` method in  the `PostHogSurveys` class,
 * which ensures the URL matches before displaying a survey for the first time.
 * That is the method that is called every second to see if there's a matching survey.
 *
 * This separation of concerns means:
 * 1. Initial URL matching is done by `getActiveMatchingSurveys` before displaying the survey
 * 2. Subsequent URL changes are handled here to hide the survey as the user navigates
 */
export function useHideSurveyOnURLChange({
    survey,
    removeSurveyFromFocus,
    setSurveyVisible,
    isPreviewMode = false,
}: UseHideSurveyOnURLChangeProps) {
    useEffect(() => {
        if (isPreviewMode || !survey.conditions?.url) {
            return
        }

        const checkUrlMatch = () => {
            const isSurveyTypeWidget = survey.type === SurveyType.Widget
            const doesSurveyMatchUrlCondition = doesSurveyUrlMatch(survey)
            const isSurveyWidgetTypeTab = survey.appearance?.widgetType === SurveyWidgetType.Tab && isSurveyTypeWidget

            if (doesSurveyMatchUrlCondition) {
                if (isSurveyWidgetTypeTab) {
                    logger.info(`Showing survey ${survey.id} because it is a feedback button tab and URL matches`)
                    setSurveyVisible(true)
                }
                return
            }

            logger.info(`Hiding survey ${survey.id} because URL does not match`)
            setSurveyVisible(false)
            return removeSurveyFromFocus(survey.id)
        }

        // Listen for browser back/forward browser history changes
        addEventListener(window, 'popstate', checkUrlMatch)
        // Listen for hash changes, for SPA frameworks that use hash-based routing
        // The hashchange event is fired when the fragment identifier of the URL has changed (the part of the URL beginning with and following the # symbol).
        addEventListener(window, 'hashchange', checkUrlMatch)

        // Listen for SPA navigation
        const originalPushState = window.history.pushState
        const originalReplaceState = window.history.replaceState

        window.history.pushState = function (...args) {
            originalPushState.apply(this, args)
            checkUrlMatch()
        }

        window.history.replaceState = function (...args) {
            originalReplaceState.apply(this, args)
            checkUrlMatch()
        }

        return () => {
            window.removeEventListener('popstate', checkUrlMatch)
            window.removeEventListener('hashchange', checkUrlMatch)
            window.history.pushState = originalPushState
            window.history.replaceState = originalReplaceState
        }
    }, [isPreviewMode, survey, removeSurveyFromFocus, setSurveyVisible])
}

export function usePopupVisibility(
    survey: Survey,
    posthog: PostHog | undefined,
    millisecondDelay: number,
    isPreviewMode: boolean,
    removeSurveyFromFocus: (id: string) => void
) {
    const [isPopupVisible, setIsPopupVisible] = useState(isPreviewMode || millisecondDelay === 0)
    const [isSurveySent, setIsSurveySent] = useState(false)

    useEffect(() => {
        if (!posthog) {
            logger.error('usePopupVisibility hook called without a PostHog instance.')
            return
        }
        if (isPreviewMode) {
            return
        }

        const handleSurveyClosed = () => {
            removeSurveyFromFocus(survey.id)
            setIsPopupVisible(false)
        }

        const handleSurveySent = () => {
            if (!survey.appearance?.displayThankYouMessage) {
                removeSurveyFromFocus(survey.id)
                setIsPopupVisible(false)
            } else {
                setIsSurveySent(true)
                removeSurveyFromFocus(survey.id)
                if (survey.appearance?.autoDisappear) {
                    setTimeout(() => {
                        setIsPopupVisible(false)
                    }, 5000)
                }
            }
        }

        const showSurvey = () => {
            // check if the url is still matching, necessary for delayed surveys, as the URL may have changed
            if (!doesSurveyUrlMatch(survey)) {
                return
            }

            setIsPopupVisible(true)
            window.dispatchEvent(new Event('PHSurveyShown'))
            posthog.capture('survey shown', {
                $survey_name: survey.name,
                $survey_id: survey.id,
                $survey_iteration: survey.current_iteration,
                $survey_iteration_start_date: survey.current_iteration_start_date,
                sessionRecordingUrl: posthog.get_session_replay_url?.(),
            })
            localStorage.setItem('lastSeenSurveyDate', new Date().toISOString())
            setTimeout(() => {
                const inputField = document
                    .querySelector(getPosthogWidgetClass(survey.id))
                    ?.shadowRoot?.querySelector('textarea, input[type="text"]') as HTMLElement
                if (inputField) {
                    inputField.focus()
                }
            }, 100)
        }

        addEventListener(window, 'PHSurveyClosed', handleSurveyClosed)
        addEventListener(window, 'PHSurveySent', handleSurveySent)

        if (millisecondDelay > 0) {
            // This path is only used for direct usage of SurveyPopup,
            // not for surveys managed by SurveyManager
            const timeoutId = setTimeout(showSurvey, millisecondDelay)
            return () => {
                clearTimeout(timeoutId)
                window.removeEventListener('PHSurveyClosed', handleSurveyClosed)
                window.removeEventListener('PHSurveySent', handleSurveySent)
            }
        } else {
            // This is the path used for surveys managed by SurveyManager
            showSurvey()
            return () => {
                window.removeEventListener('PHSurveyClosed', handleSurveyClosed)
                window.removeEventListener('PHSurveySent', handleSurveySent)
            }
        }
    }, [])

    useHideSurveyOnURLChange({
        survey,
        removeSurveyFromFocus,
        setSurveyVisible: setIsPopupVisible,
        isPreviewMode,
    })

    return { isPopupVisible, isSurveySent, setIsPopupVisible }
}

interface SurveyPopupProps {
    survey: Survey
    forceDisableHtml?: boolean
    posthog?: PostHog
    style?: React.CSSProperties
    previewPageIndex?: number | undefined
    removeSurveyFromFocus: (id: string) => void
    isPopup?: boolean
    onPreviewSubmit?: (res: string | string[] | number | null) => void
    onPopupSurveyDismissed?: () => void
    onCloseConfirmationMessage?: () => void
}

export function SurveyPopup({
    survey,
    forceDisableHtml,
    posthog,
    style,
    previewPageIndex,
    removeSurveyFromFocus,
    isPopup,
    onPreviewSubmit = () => {},
    onPopupSurveyDismissed = () => {},
    onCloseConfirmationMessage = () => {},
}: SurveyPopupProps) {
    const isPreviewMode = Number.isInteger(previewPageIndex)
    // NB: The client-side code passes the millisecondDelay in seconds, but setTimeout expects milliseconds, so we multiply by 1000
    const surveyPopupDelayMilliseconds = survey.appearance?.surveyPopupDelaySeconds
        ? survey.appearance.surveyPopupDelaySeconds * 1000
        : 0
    const { isPopupVisible, isSurveySent, setIsPopupVisible } = usePopupVisibility(
        survey,
        posthog,
        surveyPopupDelayMilliseconds,
        isPreviewMode,
        removeSurveyFromFocus
    )
    const shouldShowConfirmation = isSurveySent || previewPageIndex === survey.questions.length
    const confirmationBoxLeftStyle = style?.left && isNumber(style?.left) ? { left: style.left - 40 } : {}

    if (isPreviewMode) {
        style = style || {}
        style.left = 'unset'
        style.right = 'unset'
        style.transform = 'unset'
    }

    return isPopupVisible ? (
        <SurveyContext.Provider
            value={{
                isPreviewMode,
                previewPageIndex: previewPageIndex,
                onPopupSurveyDismissed: () => {
                    dismissedSurveyEvent(survey, posthog, isPreviewMode)
                    onPopupSurveyDismissed()
                },
                isPopup: isPopup || false,
                onPreviewSubmit,
            }}
        >
            {!shouldShowConfirmation ? (
                <Questions
                    survey={survey}
                    forceDisableHtml={!!forceDisableHtml}
                    posthog={posthog}
                    styleOverrides={style}
                />
            ) : (
                <ConfirmationMessage
                    header={survey.appearance?.thankYouMessageHeader || 'Thank you!'}
                    description={survey.appearance?.thankYouMessageDescription || ''}
                    forceDisableHtml={!!forceDisableHtml}
                    contentType={survey.appearance?.thankYouMessageDescriptionContentType}
                    appearance={survey.appearance || defaultSurveyAppearance}
                    styleOverrides={{ ...style, ...confirmationBoxLeftStyle }}
                    onClose={() => {
                        setIsPopupVisible(false)
                        onCloseConfirmationMessage()
                    }}
                />
            )}
        </SurveyContext.Provider>
    ) : null
}

export function Questions({
    survey,
    forceDisableHtml,
    posthog,
    styleOverrides,
}: {
    survey: Survey
    forceDisableHtml: boolean
    posthog?: PostHog
    styleOverrides?: React.CSSProperties
}) {
    const textColor = getContrastingTextColor(
        survey.appearance?.backgroundColor || defaultSurveyAppearance.backgroundColor
    )
    const [questionsResponses, setQuestionsResponses] = useState({})
    const { previewPageIndex, onPopupSurveyDismissed, isPopup, onPreviewSubmit } = useContext(SurveyContext)
    const [currentQuestionIndex, setCurrentQuestionIndex] = useState(previewPageIndex || 0)
    const surveyQuestions = useMemo(() => getDisplayOrderQuestions(survey), [survey])

    // Sync preview state
    useEffect(() => {
        setCurrentQuestionIndex(previewPageIndex ?? 0)
    }, [previewPageIndex])

    const onNextButtonClick = ({
        res,
        displayQuestionIndex,
        questionId,
    }: {
        res: string | string[] | number | null
        displayQuestionIndex: number
        questionId?: string
    }) => {
        if (!posthog) {
            logger.error('onNextButtonClick called without a PostHog instance.')
            return
        }

        if (!questionId) {
            logger.error('onNextButtonClick called without a questionId.')
            return
        }

        const responseKey = getSurveyResponseKey(questionId)

        setQuestionsResponses({ ...questionsResponses, [responseKey]: res })

        const nextStep = getNextSurveyStep(survey, displayQuestionIndex, res)
        if (nextStep === SurveyQuestionBranchingType.End) {
            sendSurveyEvent({ ...questionsResponses, [responseKey]: res }, survey, posthog)
        } else {
            setCurrentQuestionIndex(nextStep)
        }
    }

    return (
        <form
            className="survey-form"
            name="surveyForm"
            style={
                isPopup
                    ? {
                          color: textColor,
                          borderColor: survey.appearance?.borderColor,
                          ...styleOverrides,
                      }
                    : {}
            }
        >
            {surveyQuestions.map((question, displayQuestionIndex) => {
                const isVisible = currentQuestionIndex === displayQuestionIndex
                return (
                    isVisible && (
                        <div
                            className="survey-box"
                            style={
                                isPopup
                                    ? {
                                          backgroundColor:
                                              survey.appearance?.backgroundColor ||
                                              defaultSurveyAppearance.backgroundColor,
                                      }
                                    : {}
                            }
                        >
                            {isPopup && (
                                <Cancel
                                    onClick={() => {
                                        onPopupSurveyDismissed()
                                    }}
                                />
                            )}
                            {getQuestionComponent({
                                question,
                                forceDisableHtml,
                                displayQuestionIndex,
                                appearance: survey.appearance || defaultSurveyAppearance,
                                onSubmit: (res) =>
                                    onNextButtonClick({
                                        res,
                                        displayQuestionIndex,
                                        questionId: question.id,
                                    }),
                                onPreviewSubmit,
                            })}
                        </div>
                    )
                )
            })}
        </form>
    )
}

export function FeedbackWidget({
    survey,
    forceDisableHtml,
    posthog,
    readOnly,
    removeSurveyFromFocus,
}: {
    survey: Survey
    forceDisableHtml?: boolean
    posthog?: PostHog
    readOnly?: boolean
    removeSurveyFromFocus: (id: string) => void
}): JSX.Element | null {
    const [isFeedbackButtonVisible, setIsFeedbackButtonVisible] = useState(true)
    const [showSurvey, setShowSurvey] = useState(false)
    const [styleOverrides, setStyleOverrides] = useState<React.CSSProperties>({})
    const widgetRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (!posthog) {
            logger.error('FeedbackWidget called without a PostHog instance.')
            return
        }
        if (readOnly) {
            return
        }

        if (survey.appearance?.widgetType === 'tab') {
            if (widgetRef.current) {
                const widgetPos = widgetRef.current.getBoundingClientRect()
                setStyleOverrides({
                    top: '50%',
                    left: parseInt(`${widgetPos.right - 360}`),
                    bottom: 'auto',
                    borderRadius: 10,
                    borderBottom: `1.5px solid ${survey.appearance?.borderColor || '#c9c6c6'}`,
                })
            }
        }
        const handleShowSurvey = (event: Event) => {
            const customEvent = event as CustomEvent
            // Check if the event is for this specific survey instance
            if (customEvent.detail?.surveyId === survey.id) {
                logger.info(`Received show event for survey ${survey.id}`)
                setStyleOverrides(customEvent.detail.position || {})
                setShowSurvey(true) // Show the survey popup
            }
        }

        addEventListener(window, DISPATCH_FEEDBACK_WIDGET_EVENT, handleShowSurvey)

        // Cleanup listener on component unmount
        return () => {
            window.removeEventListener(DISPATCH_FEEDBACK_WIDGET_EVENT, handleShowSurvey)
        }
    }, [
        posthog,
        readOnly,
        survey.id,
        survey.appearance?.widgetType,
        survey.appearance?.widgetSelector,
        survey.appearance?.borderColor,
    ])

    useHideSurveyOnURLChange({
        survey,
        removeSurveyFromFocus,
        setSurveyVisible: setIsFeedbackButtonVisible,
    })

    if (!isFeedbackButtonVisible) {
        return null
    }

    const resetShowSurvey = () => {
        setShowSurvey(false)
    }

    return (
        <Preact.Fragment>
            {survey.appearance?.widgetType === 'tab' && (
                <div
                    className="ph-survey-widget-tab"
                    ref={widgetRef}
                    onClick={() => !readOnly && setShowSurvey(!showSurvey)}
                    style={{ color: getContrastingTextColor(survey.appearance.widgetColor) }}
                >
                    <div className="ph-survey-widget-tab-icon"></div>
                    {survey.appearance?.widgetLabel || ''}
                </div>
            )}
            {showSurvey && (
                <SurveyPopup
                    key={'feedback-widget-survey'}
                    posthog={posthog}
                    survey={survey}
                    forceDisableHtml={forceDisableHtml}
                    style={styleOverrides}
                    removeSurveyFromFocus={removeSurveyFromFocus}
                    isPopup={true}
                    onPopupSurveyDismissed={resetShowSurvey}
                    onCloseConfirmationMessage={resetShowSurvey}
                />
            )}
        </Preact.Fragment>
    )
}

interface GetQuestionComponentProps {
    question: SurveyQuestion
    forceDisableHtml: boolean
    displayQuestionIndex: number
    appearance: SurveyAppearance
    onSubmit: (res: string | string[] | number | null) => void
    onPreviewSubmit: (res: string | string[] | number | null) => void
}

const getQuestionComponent = ({
    question,
    forceDisableHtml,
    displayQuestionIndex,
    appearance,
    onSubmit,
    onPreviewSubmit,
}: GetQuestionComponentProps): JSX.Element => {
    const questionComponents = {
        [SurveyQuestionType.Open]: OpenTextQuestion,
        [SurveyQuestionType.Link]: LinkQuestion,
        [SurveyQuestionType.Rating]: RatingQuestion,
        [SurveyQuestionType.SingleChoice]: MultipleChoiceQuestion,
        [SurveyQuestionType.MultipleChoice]: MultipleChoiceQuestion,
    }

    const commonProps = {
        question,
        forceDisableHtml,
        appearance,
        onPreviewSubmit: (res: string | string[] | number | null) => {
            onPreviewSubmit(res)
        },
        onSubmit: (res: string | string[] | number | null) => {
            onSubmit(res)
        },
    }

    const additionalProps: Record<SurveyQuestionType, any> = {
        [SurveyQuestionType.Open]: {},
        [SurveyQuestionType.Link]: {},
        [SurveyQuestionType.Rating]: { displayQuestionIndex },
        [SurveyQuestionType.SingleChoice]: { displayQuestionIndex },
        [SurveyQuestionType.MultipleChoice]: { displayQuestionIndex },
    }

    const Component = questionComponents[question.type]
    const componentProps = { ...commonProps, ...additionalProps[question.type] }

    return <Component {...componentProps} />
}
