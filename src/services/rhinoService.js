import rhino3dm from 'rhino3dm';
import compute from 'compute-rhino3d';

compute.url = 'http://localhost:5000/';

export async function solveCarePathway(hospitals, roads, subdist) {
    // 1. Initialize rhino3dm and AWAIT the instance
    const rhino = await rhino3dm();

    const ghResponse = await fetch('/carepathway2x.gh');

    const ghBuffer = await ghResponse.arrayBuffer();
    const ghArray = new Uint8Array(ghBuffer);

    //console.log(`Loaded GH File: ${ghBuffer.byteLength} bytes`);

    const createInputTree = (paramName, dataObject) => {
        const serializedData = JSON.stringify(dataObject);
        const tree = new compute.Grasshopper.DataTree(paramName);
        tree.append([0], [serializedData]);
        return tree; 
    };

    const trees = [
        createInputTree('hospitals_geojson', hospitals),
    ];

   //console.log("Prepared input trees for Rhino.Compute:", trees);

    const response = await compute.Grasshopper.evaluateDefinition(ghArray, trees);

    const extractOutput = (paramName) => {
        const outputNode = response.values.find(v => v.ParamName === paramName);
        if (outputNode) {
            const cleanString = JSON.parse(outputNode.InnerTree['{0}'][0].data);
            return JSON.parse(cleanString);
        }
        return null;
    };

    const carepathway = extractOutput('carepathway_geojson');
    //const hospitalServed = extractOutput('hospital_served_geojson');



    return {carepathway};
}