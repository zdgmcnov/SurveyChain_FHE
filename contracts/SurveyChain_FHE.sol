pragma solidity ^0.8.24;

import { FHE, euint32, externalEuint32 } from "@fhevm/solidity/lib/FHE.sol";
import { ZamaEthereumConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract SurveyChain_FHE is ZamaEthereumConfig {
    
    struct Survey {
        string title;
        euint32 encryptedResponse;
        uint256 participantCount;
        uint256 questionCount;
        address creator;
        uint256 createdAt;
        bool isActive;
    }

    struct AggregationResult {
        uint32 sum;
        uint32 count;
        bool isVerified;
    }

    mapping(string => Survey) public surveys;
    mapping(string => AggregationResult) public results;
    mapping(string => mapping(address => bool)) public hasResponded;

    string[] public surveyIds;

    event SurveyCreated(string indexed surveyId, address indexed creator);
    event ResponseSubmitted(string indexed surveyId, address indexed respondent);
    event ResultsAggregated(string indexed surveyId, uint32 sum, uint32 count);
    event ResultsVerified(string indexed surveyId);

    constructor() ZamaEthereumConfig() {
    }

    function createSurvey(
        string calldata surveyId,
        string calldata title,
        uint256 questionCount
    ) external {
        require(bytes(surveys[surveyId].title).length == 0, "Survey already exists");
        
        surveys[surveyId] = Survey({
            title: title,
            encryptedResponse: euint32(0),
            participantCount: 0,
            questionCount: questionCount,
            creator: msg.sender,
            createdAt: block.timestamp,
            isActive: true
        });
        
        surveyIds.push(surveyId);
        
        emit SurveyCreated(surveyId, msg.sender);
    }

    function submitResponse(
        string calldata surveyId,
        externalEuint32 encryptedResponse,
        bytes calldata inputProof
    ) external {
        require(bytes(surveys[surveyId].title).length > 0, "Survey does not exist");
        require(surveys[surveyId].isActive, "Survey is not active");
        require(!hasResponded[surveyId][msg.sender], "Already responded");
        
        require(FHE.isInitialized(FHE.fromExternal(encryptedResponse, inputProof)), "Invalid encrypted input");
        
        euint32 encryptedValue = FHE.fromExternal(encryptedResponse, inputProof);
        FHE.allowThis(encryptedValue);
        FHE.makePubliclyDecryptable(encryptedValue);

        if (surveys[surveyId].participantCount == 0) {
            surveys[surveyId].encryptedResponse = encryptedValue;
        } else {
            surveys[surveyId].encryptedResponse = FHE.add(
                surveys[surveyId].encryptedResponse, 
                encryptedValue
            );
        }

        surveys[surveyId].participantCount++;
        hasResponded[surveyId][msg.sender] = true;
        
        emit ResponseSubmitted(surveyId, msg.sender);
    }

    function aggregateResults(
        string calldata surveyId
    ) external {
        require(bytes(surveys[surveyId].title).length > 0, "Survey does not exist");
        require(surveys[surveyId].isActive, "Survey is not active");
        require(surveys[surveyId].participantCount > 0, "No responses to aggregate");
        require(!results[surveyId].isVerified, "Results already verified");

        euint32 encryptedSum = surveys[surveyId].encryptedResponse;
        uint32 sum = FHE.decrypt(encryptedSum);
        
        results[surveyId] = AggregationResult({
            sum: sum,
            count: uint32(surveys[surveyId].participantCount),
            isVerified: false
        });
        
        emit ResultsAggregated(surveyId, sum, uint32(surveys[surveyId].participantCount));
    }

    function verifyResults(
        string calldata surveyId,
        bytes memory abiEncodedClearValue,
        bytes memory decryptionProof
    ) external {
        require(bytes(surveys[surveyId].title).length > 0, "Survey does not exist");
        require(!results[surveyId].isVerified, "Results already verified");

        bytes32[] memory cts = new bytes32[](1);
        cts[0] = FHE.toBytes32(surveys[surveyId].encryptedResponse);

        FHE.checkSignatures(cts, abiEncodedClearValue, decryptionProof);

        uint32 decodedValue = abi.decode(abiEncodedClearValue, (uint32));
        require(decodedValue == results[surveyId].sum, "Decryption verification failed");

        results[surveyId].isVerified = true;
        surveys[surveyId].isActive = false;

        emit ResultsVerified(surveyId);
    }

    function getSurvey(string calldata surveyId) external view returns (
        string memory title,
        uint256 participantCount,
        uint256 questionCount,
        address creator,
        uint256 createdAt,
        bool isActive
    ) {
        require(bytes(surveys[surveyId].title).length > 0, "Survey does not exist");
        Survey storage s = surveys[surveyId];
        
        return (
            s.title,
            s.participantCount,
            s.questionCount,
            s.creator,
            s.createdAt,
            s.isActive
        );
    }

    function getResults(string calldata surveyId) external view returns (
        uint32 sum,
        uint32 count,
        bool isVerified
    ) {
        require(bytes(surveys[surveyId].title).length > 0, "Survey does not exist");
        AggregationResult storage r = results[surveyId];
        
        return (
            r.sum,
            r.count,
            r.isVerified
        );
    }

    function getAllSurveyIds() external view returns (string[] memory) {
        return surveyIds;
    }

    function hasUserResponded(string calldata surveyId, address user) external view returns (bool) {
        return hasResponded[surveyId][user];
    }
}


